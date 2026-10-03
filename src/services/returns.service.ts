import { prisma } from '../db.js';
import { DomainError, NotFoundError, ValidationError } from '../http/errors.js';
import { guestTokenFor } from '../auth/guestToken.js';
import { env } from '../config/env.js';
import { getConfig } from './config.service.js';
import { adjust } from './inventory.service.js';
import { orderEmails } from './notification.service.js';
import { transition, type Actor } from './order.service.js';

/**
 * Returns (ORDER_LIFECYCLE.md §Returns policy, RETURN_FLOW.md). Self-serve UI is
 * post-launch; these endpoints back admin-assisted returns today.
 */

export const RETURN_REASONS = ['wrong-size', 'damaged', 'wrong-item', 'not-as-described'] as const;
export type ReturnReason = (typeof RETURN_REASONS)[number];
const PHOTO_REQUIRED: ReturnReason[] = ['damaged', 'wrong-item'];

export async function requestReturn(
  orderNo: string,
  input: { items: { orderItemId: string; qty: number }[]; reason: ReturnReason; note?: string; photoUrls?: string[]; bankDetails?: Record<string, string> },
  actor: Actor,
) {
  const cfg = await getConfig();
  const o = await prisma().order.findUnique({
    where: { orderNo },
    select: { id: true, status: true, deliveredAt: true, items: { select: { id: true, qty: true, variant: { select: { product: { select: { isFinalSale: true } } } } } } },
  });
  if (!o) throw new NotFoundError('Order not found');
  if (o.status !== 'DELIVERED' || !o.deliveredAt) throw new DomainError('ILLEGAL_TRANSITION', 'Returns can be requested only after delivery');
  if (Date.now() - o.deliveredAt.getTime() > cfg.returnWindowDays * 86_400_000)
    throw new DomainError('RETURN_WINDOW_CLOSED', `The ${cfg.returnWindowDays}-day return window for this order has closed`);
  if (PHOTO_REQUIRED.includes(input.reason) && !input.photoUrls?.length) throw new ValidationError({ photoUrls: 'Add a photo of the problem' });
  if (!input.items.length) throw new ValidationError({ items: 'Choose at least one item to return' });
  for (const it of input.items) {
    const line = o.items.find((l) => l.id === it.orderItemId);
    if (!line) throw new ValidationError({ items: 'That item isn’t part of this order' });
    if (it.qty < 1 || it.qty > line.qty) throw new ValidationError({ items: 'Return quantity can’t be more than you ordered' });
    if (line.variant?.product.isFinalSale) throw new DomainError('ITEM_FINAL_SALE', 'Final-sale items can’t be returned');
  }
  const created = await prisma().$transaction(async (tx) => {
    const r = await tx.returnRequest.create({
      data: {
        orderId: o.id,
        reason: input.reason,
        customerNote: input.note,
        photoUrls: input.photoUrls ?? [],
        refundBankDetails: input.bankDetails,
        items: { create: input.items.map((i) => ({ orderItemId: i.orderItemId, qty: i.qty })) },
      },
      select: { id: true, status: true },
    });
    await transition(orderNo, 'RETURN_REQUESTED', actor, { note: `Return requested: ${input.reason}` }, tx);
    return r;
  });
  return { returnId: created.id, status: created.status };
}

async function loadReturn(returnId: string) {
  const r = await prisma().returnRequest.findUnique({
    where: { id: returnId },
    select: {
      id: true, status: true, reason: true,
      order: { select: { id: true, orderNo: true, userId: true, contactEmail: true, shipName: true, totalPaisa: true, shippingPaisa: true } },
      items: { select: { id: true, qty: true, orderItem: { select: { variantId: true, unitPricePaisa: true } } } },
    },
  });
  if (!r) throw new NotFoundError('Return not found');
  return r;
}

export async function decideReturn(returnId: string, input: { approve: boolean; note: string }, actorId: string) {
  const r = await loadReturn(returnId);
  if (r.status !== 'REQUESTED') throw new DomainError('ILLEGAL_TRANSITION', 'This return has already been decided');
  await prisma().$transaction(async (tx) => {
    await tx.returnRequest.update({ where: { id: r.id }, data: { status: input.approve ? 'APPROVED' : 'REJECTED', adminNote: input.note } });
    if (!input.approve) await transition(r.order.orderNo, 'COMPLETED', { type: 'ADMIN', id: actorId }, { note: `Return declined: ${input.note}` }, tx);
  });
  const o = r.order;
  orderEmails.returnDecision({
    orderNo: o.orderNo, email: o.contactEmail, name: o.shipName.split(' ')[0]!, totalPaisa: o.totalPaisa,
    trackUrl: `${env().SITE_URL}/order/${o.orderNo}${o.userId ? '' : `?t=${guestTokenFor(o.orderNo)}`}`,
    approved: input.approve, note: input.note,
  });
  return { returnId: r.id, status: input.approve ? 'APPROVED' : 'REJECTED' };
}

/**
 * Parcel received: QC each line, restock SELLABLE units (ledger source RETURN),
 * order → RETURNED. Returns the refund due; the admin records the actual
 * transfer via POST /admin/orders/:orderNo/refund.
 */
export async function receiveReturn(returnId: string, input: { items: { id: string; qcOutcome: 'SELLABLE' | 'DAMAGED' }[] }, actorId: string) {
  const r = await loadReturn(returnId);
  if (r.status !== 'APPROVED') throw new DomainError('ILLEGAL_TRANSITION', 'Only approved returns can be received');
  const outcomes = new Map(input.items.map((i) => [i.id, i.qcOutcome]));
  if (r.items.some((i) => !outcomes.has(i.id))) throw new ValidationError({ items: 'Record a QC outcome for every returned item' });

  await prisma().$transaction(async (tx) => {
    for (const it of r.items) {
      const qc = outcomes.get(it.id)!;
      await tx.returnItem.update({ where: { id: it.id }, data: { qcOutcome: qc } });
      if (qc === 'SELLABLE' && it.orderItem.variantId)
        await adjust(tx, { variantId: it.orderItem.variantId, delta: it.qty, reason: 'return received (sellable)', source: 'RETURN', refId: r.id, actorId });
    }
    await tx.returnRequest.update({ where: { id: r.id }, data: { status: 'RECEIVED' } });
    await transition(r.order.orderNo, 'RETURNED', { type: 'ADMIN', id: actorId }, { note: 'Return received and checked' }, tx);
  });

  const itemsPaisa = r.items.reduce((a, i) => a + i.orderItem.unitPricePaisa * i.qty, 0);
  // Wrong item / damaged: shipping is refunded too (ORDER_LIFECYCLE.md §Returns policy).
  const refundDuePaisa = itemsPaisa + (r.reason === 'damaged' || r.reason === 'wrong-item' ? r.order.shippingPaisa : 0);
  return { returnId: r.id, status: 'RECEIVED', refundDuePaisa };
}

export async function listReturns(status?: string) {
  return prisma().returnRequest.findMany({
    where: status ? { status: status as never } : {},
    orderBy: { createdAt: 'desc' },
    take: 100,
    select: { id: true, status: true, reason: true, customerNote: true, photoUrls: true, createdAt: true, order: { select: { orderNo: true, shipName: true } }, items: { select: { id: true, qty: true, qcOutcome: true, orderItem: { select: { productName: true, sizeLabel: true } } } } },
  });
}
