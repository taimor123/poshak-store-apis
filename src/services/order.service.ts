import type { Prisma } from '../generated/prisma/client.js';
import { env } from '../config/env.js';
import { prisma, type Tx } from '../db.js';
import { guestTokenFor, isValidGuestToken } from '../auth/guestToken.js';
import type { SessionUser } from '../auth/authz.js';
import { hit } from '../http/middleware/rateLimit.js';
import {
  DomainError,
  IllegalTransitionError,
  NotFoundError,
  PriceMismatchError,
  RateLimitedError,
  StockConflictError,
  ValidationError,
  type StockConflictLine,
} from '../http/errors.js';
import { logger } from '../logger.js';
import { getConfig } from './config.service.js';
import { getCart, clearCartTx, type CartOwner } from './cart.service.js';
import { adjust } from './inventory.service.js';
import { adminEmails, orderEmails } from './notification.service.js';
import { quote, type DeliveryMethod } from './shipping.service.js';

/**
 * Orders (docs/ECOMMERCE_CORE/ORDER_LIFECYCLE.md, CHECKOUT_FLOW.md).
 *   place()      — the one atomic placement transaction.
 *   transition() — the ONLY writer of Order.status; enforces the table and
 *                  writes an OrderEvent in the same transaction.
 */

export type OrderStatus =
  | 'PENDING_PAYMENT' | 'PENDING' | 'CONFIRMED' | 'PACKED' | 'SHIPPED' | 'DELIVERED'
  | 'COMPLETED' | 'CANCELLED' | 'RETURN_REQUESTED' | 'RETURNED' | 'REFUNDED';
export type ActorType = 'CUSTOMER' | 'ADMIN' | 'SYSTEM';
export type Actor = { type: ActorType; id?: string };

/** Legal transitions → who may perform them. Anything not listed is rejected, even for admins. */
export const TRANSITIONS: Partial<Record<OrderStatus, Partial<Record<OrderStatus, ActorType[]>>>> = {
  PENDING_PAYMENT: { PENDING: ['SYSTEM', 'ADMIN'], CANCELLED: ['SYSTEM'] },
  PENDING: { CONFIRMED: ['ADMIN'], CANCELLED: ['CUSTOMER', 'ADMIN'] },
  CONFIRMED: { PACKED: ['ADMIN'], CANCELLED: ['CUSTOMER', 'ADMIN'] },
  PACKED: { SHIPPED: ['ADMIN'], CANCELLED: ['ADMIN'] },
  // SHIPPED → CANCELLED: courier returned the parcel after 3 failed attempts (ORDER_LIFECYCLE.md §Edge cases).
  SHIPPED: { DELIVERED: ['ADMIN'], REFUNDED: ['ADMIN'], CANCELLED: ['ADMIN'] },
  DELIVERED: { COMPLETED: ['SYSTEM'], RETURN_REQUESTED: ['CUSTOMER', 'ADMIN'] },
  RETURN_REQUESTED: { RETURNED: ['ADMIN'], COMPLETED: ['ADMIN'] },
};

export const canTransition = (from: OrderStatus, to: OrderStatus, actor: ActorType) => !!TRANSITIONS[from]?.[to]?.includes(actor);

/** Statuses that put stock back on cancellation (nothing has left the building or it came back). */
const RESTOCK_ON_CANCEL: OrderStatus[] = ['PENDING', 'CONFIRMED', 'PACKED', 'SHIPPED'];

// ─── Placement ──────────────────────────────────────────────────────────────

export type PlaceInput = {
  contact: { email: string; phone: string };
  address: { name: string; phone?: string; line1: string; city: string; province?: string; notes?: string };
  paymentMethod: 'COD';
  deliveryMethod: DeliveryMethod;
  clientTotalPaisa: number;
  idempotencyKey: string;
};

export type PlacedOrder = { orderNo: string; status: OrderStatus; totalPaisa: number; guestToken: string | null; replay: boolean };

/** "PSK-YYYYMM" in Pakistan time. */
function periodPKT(d = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi', year: 'numeric', month: '2-digit' }).formatToParts(d);
  return `${parts.find((p) => p.type === 'year')!.value}${parts.find((p) => p.type === 'month')!.value}`;
}

/** Gap-free monthly counter; the row lock serialises concurrent placements on it only. */
async function nextOrderNo(tx: Tx) {
  const period = periodPKT();
  const rows = await tx.$queryRaw<{ lastValue: number }[]>`
    INSERT INTO "OrderSequence" ("period", "lastValue", "updatedAt") VALUES (${period}, 1, now())
    ON CONFLICT ("period") DO UPDATE SET "lastValue" = "OrderSequence"."lastValue" + 1, "updatedAt" = now()
    RETURNING "lastValue"`;
  return `PSK-${period}-${String(rows[0]!.lastValue).padStart(4, '0')}`;
}

const trackUrl = (orderNo: string, guestToken: string | null) =>
  `${env().SITE_URL}/order/${orderNo}${guestToken ? `?t=${guestToken}` : ''}`;

async function replayFor(key: string): Promise<PlacedOrder | null> {
  const o = await prisma().order.findUnique({ where: { idempotencyKey: key }, select: { orderNo: true, status: true, totalPaisa: true, userId: true } });
  return o && { orderNo: o.orderNo, status: o.status, totalPaisa: o.totalPaisa, guestToken: o.userId ? null : guestTokenFor(o.orderNo), replay: true };
}

export async function place(input: PlaceInput, owner: CartOwner, user: SessionUser | null): Promise<PlacedOrder> {
  // Duplicate submit → the original order, no second order.
  const replay = await replayFor(input.idempotencyKey);
  if (replay) return replay;

  if (!hit(`order-phone:${input.contact.phone}`, 5, 60 * 60 * 1000)) throw new RateLimitedError('Too many orders from this number. Please try again later or message us on WhatsApp.');

  const cfg = await getConfig();
  if (!cfg.codEnabled) throw new ValidationError({ paymentMethod: 'Cash on delivery is unavailable right now' });

  const cart = await getCart(owner);
  if (!cart.id || !cart.lines.length) throw new ValidationError({ cart: 'Your cart is empty' });
  const blocked = cart.lines.filter((l) => l.status !== 'ok');
  if (blocked.length) throw new StockConflictError(blocked.map((l) => ({ variantId: l.variantId, requested: l.qty, available: l.status === 'removed' ? 0 : l.available })));

  const shipping = await quote(input.address.city, cart.subtotalPaisa, input.deliveryMethod);
  const totalPaisa = cart.subtotalPaisa + shipping.feePaisa;
  if (input.clientTotalPaisa !== totalPaisa) throw new PriceMismatchError(totalPaisa);

  const lines = [...cart.lines].sort((a, b) => a.variantId.localeCompare(b.variantId)); // fixed lock order → no deadlocks
  const variants = await prisma().productVariant.findMany({ where: { id: { in: lines.map((l) => l.variantId) } }, select: { id: true, sku: true } });
  const skuOf = new Map(variants.map((v) => [v.id, v.sku]));

  let order: { id: string; orderNo: string; status: OrderStatus; totalPaisa: number };
  try {
    order = await prisma().$transaction(async (tx) => {
      const orderNo = await nextOrderNo(tx);
      const created = await tx.order.create({
        data: {
          orderNo,
          userId: user?.id,
          guestEmail: user ? null : input.contact.email,
          guestPhone: user ? null : input.contact.phone,
          idempotencyKey: input.idempotencyKey,
          status: 'PENDING',
          subtotalPaisa: cart.subtotalPaisa,
          shippingPaisa: shipping.feePaisa,
          discountPaisa: 0,
          totalPaisa,
          contactEmail: input.contact.email,
          contactPhone: input.contact.phone,
          shipName: input.address.name,
          shipPhone: input.address.phone ?? input.contact.phone,
          shipLine1: input.address.line1,
          shipCity: shipping.city,
          shipProvince: input.address.province,
          shipNotes: input.address.notes,
          items: {
            create: lines.map((l) => ({
              variantId: l.variantId,
              productName: l.product.name,
              productSlug: l.product.slug,
              sizeLabel: l.size,
              color: l.color,
              sku: skuOf.get(l.variantId) ?? '',
              unitPricePaisa: l.unitPricePaisa,
              qty: l.qty,
              imageUrl: l.product.image?.url ?? '',
            })),
          },
          payments: { create: { method: 'COD', status: 'PENDING', amountPaisa: totalPaisa } },
          events: { create: { fromStatus: null, toStatus: 'PENDING', actorType: user ? 'CUSTOMER' : 'SYSTEM', actorId: user?.id, note: `COD · ${shipping.method.toLowerCase()} delivery` } },
        },
        select: { id: true, orderNo: true, status: true, totalPaisa: true },
      });
      // COD decrements at placement. Conditional UPDATE per line: the oversell guard.
      for (const l of lines) await adjust(tx, { variantId: l.variantId, delta: -l.qty, reason: 'order placed', source: 'ORDER', refId: created.id, actorId: user?.id });
      await clearCartTx(tx, cart.id!);
      return created;
    });
  } catch (e) {
    if (e instanceof StockConflictError) throw await stockConflictFor(lines);
    // Concurrent duplicate submit: the unique idempotency key lost the race → replay the winner.
    if (isUniqueViolation(e, 'idempotencyKey')) {
      const r = await replayFor(input.idempotencyKey);
      if (r) return r;
    }
    throw e;
  }

  const guestToken = user ? null : guestTokenFor(order.orderNo);
  orderEmails.placed({ orderNo: order.orderNo, email: input.contact.email, name: input.address.name.split(' ')[0]!, totalPaisa, trackUrl: trackUrl(order.orderNo, guestToken) });
  void notifyAdmins(order.orderNo, totalPaisa);
  logger.info({ orderNo: order.orderNo, totalPaisa, userId: user?.id }, 'order placed');
  return { orderNo: order.orderNo, status: order.status, totalPaisa: order.totalPaisa, guestToken, replay: false };
}

/** After a failed decrement: per-line availability for the checkout banner. */
async function stockConflictFor(lines: { variantId: string; qty: number }[]) {
  const vs = await prisma().productVariant.findMany({ where: { id: { in: lines.map((l) => l.variantId) } }, select: { id: true, stock: true } });
  const conflicts: StockConflictLine[] = lines
    .map((l) => ({ variantId: l.variantId, requested: l.qty, available: vs.find((v) => v.id === l.variantId)?.stock ?? 0 }))
    .filter((l) => l.available < l.requested);
  return new StockConflictError(conflicts);
}

function isUniqueViolation(e: unknown, field: string) {
  const err = e as { code?: string; meta?: { target?: unknown; driverAdapterError?: { cause?: { constraint?: { fields?: string[] } } } }; message?: string };
  if (err?.code !== 'P2002') return false;
  const target = JSON.stringify(err.meta ?? {}) + (err.message ?? '');
  return target.includes(field);
}

async function notifyAdmins(orderNo: string, totalPaisa: number) {
  const admins = await prisma().user.findMany({ where: { role: 'ADMIN' }, select: { email: true } });
  for (const a of admins) adminEmails.newOrder(a.email, orderNo, totalPaisa);
}

// ─── Transitions ────────────────────────────────────────────────────────────

export type TransitionOpts = { note?: string; courier?: string; trackingNo?: string; reason?: string };

/**
 * The only writer of Order.status. Optimistic guard (`AND status = from`) so a
 * concurrent change yields ILLEGAL_TRANSITION instead of a lost update.
 * Pass `tx` to join a caller's transaction (returns flow).
 */
export async function transition(orderNo: string, to: OrderStatus, actor: Actor, opts: TransitionOpts = {}, txIn?: Tx) {
  const run = async (tx: Tx) => {
    const o = await tx.order.findUnique({ where: { orderNo }, select: { id: true, status: true, items: { select: { variantId: true, qty: true } } } });
    if (!o) throw new NotFoundError('Order not found');
    const from = o.status as OrderStatus;
    if (!canTransition(from, to, actor.type)) throw new IllegalTransitionError(from, to);
    if (to === 'SHIPPED' && (!opts.courier?.trim() || !opts.trackingNo?.trim()))
      throw new ValidationError({ courier: 'Courier is required', trackingNo: 'Tracking number is required' }, 'Add the courier and tracking number to mark it shipped');
    if (to === 'CANCELLED' && !(opts.reason ?? opts.note)?.trim()) throw new ValidationError({ reason: 'Give a reason for cancelling' });

    const data: Prisma.OrderUpdateManyMutationInput = { status: to };
    if (to === 'SHIPPED') Object.assign(data, { courier: opts.courier!.trim(), trackingNo: opts.trackingNo!.trim() });
    if (to === 'DELIVERED') data.deliveredAt = new Date();
    if (to === 'CANCELLED') data.cancelReason = (opts.reason ?? opts.note)!.trim();

    const n = await tx.order.updateMany({ where: { id: o.id, status: from }, data });
    if (n.count === 0) throw new IllegalTransitionError(from, to); // lost a race

    if (to === 'CANCELLED' && RESTOCK_ON_CANCEL.includes(from))
      for (const it of o.items.filter((i) => i.variantId).sort((a, b) => a.variantId!.localeCompare(b.variantId!)))
        await adjust(tx, { variantId: it.variantId!, delta: it.qty, reason: 'order cancelled', source: 'CANCEL', refId: o.id, actorId: actor.id });

    if (to === 'DELIVERED')
      await tx.payment.updateMany({ where: { orderId: o.id, method: 'COD', status: 'PENDING' }, data: { status: 'COLLECTED', collectedAt: new Date() } });
    if (to === 'CANCELLED') await tx.payment.updateMany({ where: { orderId: o.id, status: 'PENDING' }, data: { status: 'FAILED' } });

    await tx.orderEvent.create({ data: { orderId: o.id, fromStatus: from, toStatus: to, actorType: actor.type, actorId: actor.id, note: opts.note ?? opts.reason } });
    return { orderId: o.id, from, to };
  };
  const result = txIn ? await run(txIn) : await prisma().$transaction(run);
  if (!txIn) void emailForTransition(orderNo, to);
  return result;
}

export async function emailForTransition(orderNo: string, to: OrderStatus) {
  try {
    const o = await prisma().order.findUnique({ where: { orderNo }, select: { orderNo: true, userId: true, contactEmail: true, shipName: true, totalPaisa: true, courier: true, trackingNo: true, cancelReason: true } });
    if (!o) return;
    const base = { orderNo: o.orderNo, email: o.contactEmail, name: o.shipName.split(' ')[0]!, totalPaisa: o.totalPaisa, trackUrl: trackUrl(o.orderNo, o.userId ? null : guestTokenFor(o.orderNo)) };
    if (to === 'CONFIRMED') orderEmails.confirmed(base);
    if (to === 'SHIPPED') orderEmails.shipped({ ...base, courier: o.courier, trackingNo: o.trackingNo });
    if (to === 'DELIVERED') orderEmails.delivered({ ...base, returnWindowDays: (await getConfig()).returnWindowDays });
    if (to === 'CANCELLED') orderEmails.cancelled({ ...base, reason: o.cancelReason });
  } catch (err) {
    logger.error({ err, orderNo }, 'transition email failed');
  }
}

/** Customer self-serve cancel (PENDING / CONFIRMED only — enforced by the table). */
export async function cancelByCustomer(orderNo: string, reason: string, actor: Actor) {
  await transition(orderNo, 'CANCELLED', { type: 'CUSTOMER', id: actor.id }, { reason });
  return orderView(orderNo, { forCustomer: true });
}

// ─── Reads ──────────────────────────────────────────────────────────────────

/**
 * Owner, admin, or a valid guest token for this order. Anything else is 404 —
 * never 403 — so order numbers can't be probed (AUTHORIZATION.md).
 */
export async function requireOrderAccess(orderNo: string, user: SessionUser | null, guestToken?: string) {
  const o = await prisma().order.findUnique({ where: { orderNo }, select: { userId: true } });
  if (!o) throw new NotFoundError('Order not found');
  const allowed = user?.role === 'ADMIN' || (!!user && o.userId === user.id) || (!o.userId && isValidGuestToken(orderNo, guestToken));
  if (!allowed) throw new NotFoundError('Order not found');
}

const orderSelect = {
  id: true, orderNo: true, status: true, userId: true,
  subtotalPaisa: true, shippingPaisa: true, discountPaisa: true, totalPaisa: true,
  contactEmail: true, contactPhone: true,
  shipName: true, shipPhone: true, shipLine1: true, shipCity: true, shipProvince: true, shipNotes: true,
  courier: true, trackingNo: true, cancelReason: true, placedAt: true, deliveredAt: true,
  items: { select: { id: true, productName: true, productSlug: true, sizeLabel: true, color: true, sku: true, unitPricePaisa: true, qty: true, imageUrl: true } },
  events: { orderBy: { createdAt: 'asc' as const }, select: { fromStatus: true, toStatus: true, actorType: true, note: true, createdAt: true } },
  payments: { select: { method: true, status: true, amountPaisa: true, collectedAt: true, refunds: { select: { amountPaisa: true, method: true, reason: true, createdAt: true } } } },
} satisfies Prisma.OrderSelect;

type OrderRow = Prisma.OrderGetPayload<{ select: typeof orderSelect }>;

function toOrderView(o: OrderRow, forCustomer: boolean) {
  return {
    orderNo: o.orderNo,
    status: o.status,
    placedAt: o.placedAt.toISOString(),
    deliveredAt: o.deliveredAt?.toISOString() ?? null,
    amounts: { subtotalPaisa: o.subtotalPaisa, shippingPaisa: o.shippingPaisa, discountPaisa: o.discountPaisa, totalPaisa: o.totalPaisa },
    contact: { email: o.contactEmail, phone: o.contactPhone },
    shipping: { name: o.shipName, phone: o.shipPhone, line1: o.shipLine1, city: o.shipCity, province: o.shipProvince, notes: o.shipNotes },
    courier: o.courier,
    trackingNo: o.trackingNo,
    cancelReason: o.cancelReason,
    items: o.items.map(({ id, ...i }) => ({ id, ...i, linePaisa: i.unitPricePaisa * i.qty })),
    timeline: o.events.map((e) => ({ status: e.toStatus, at: e.createdAt.toISOString(), ...(forCustomer ? {} : { from: e.fromStatus, actor: e.actorType, note: e.note }) })),
    payment: o.payments[0] ? { method: o.payments[0].method, status: o.payments[0].status, amountPaisa: o.payments[0].amountPaisa, refunds: o.payments.flatMap((p) => p.refunds) } : null,
    canCancel: o.status === 'PENDING' || o.status === 'CONFIRMED',
    isGuest: !o.userId,
  };
}

export async function orderView(orderNo: string, { forCustomer }: { forCustomer: boolean }) {
  const o = await prisma().order.findUnique({ where: { orderNo }, select: orderSelect });
  if (!o) throw new NotFoundError('Order not found');
  return toOrderView(o, forCustomer);
}

/**
 * "Track without signing in": order number + the mobile it was placed with.
 * Mismatch and unknown order look identical (404). Rate-limited at the route.
 */
export async function trackByPhone(orderNo: string, phone: string) {
  const o = await prisma().order.findUnique({ where: { orderNo }, select: { contactPhone: true } });
  if (!o || o.contactPhone !== phone) throw new NotFoundError('We couldn’t find that order. Check the number in your SMS, or message us on WhatsApp.');
  return { ...(await orderView(orderNo, { forCustomer: true })), guestToken: guestTokenFor(orderNo) };
}

export async function listMyOrders(userId: string, cursor: string | undefined, limit: number) {
  const rows = await prisma().order.findMany({
    where: { userId },
    orderBy: [{ placedAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    ...(cursor && { cursor: { orderNo: cursor }, skip: 1 }),
    select: orderSelect,
  });
  const items = rows.slice(0, limit).map((o) => toOrderView(o, true));
  return { items, nextCursor: rows.length > limit ? items.at(-1)!.orderNo : null };
}

// ─── Admin ──────────────────────────────────────────────────────────────────

export const STATUS_TABS: Record<string, OrderStatus[]> = {
  'to-confirm': ['PENDING'],
  'to-pack': ['CONFIRMED'],
  'to-ship': ['PACKED'],
  shipped: ['SHIPPED'],
  delivered: ['DELIVERED', 'COMPLETED'],
  returns: ['RETURN_REQUESTED', 'RETURNED', 'REFUNDED'],
  cancelled: ['CANCELLED'],
};

export async function adminListOrders(opts: { statusTab?: string; q?: string; cursor?: string; limit: number }) {
  const statuses = opts.statusTab ? STATUS_TABS[opts.statusTab] : undefined;
  const q = opts.q?.trim();
  const where: Prisma.OrderWhereInput = {
    ...(statuses && { status: { in: statuses } }),
    ...(q && {
      OR: [
        { orderNo: { contains: q, mode: 'insensitive' } },
        { shipName: { contains: q, mode: 'insensitive' } },
        { contactPhone: { contains: q.replace(/^0/, '') } },
        { contactEmail: { contains: q, mode: 'insensitive' } },
      ],
    }),
  };
  const rows = await prisma().order.findMany({
    where,
    orderBy: [{ placedAt: 'desc' }, { id: 'desc' }],
    take: opts.limit + 1,
    ...(opts.cursor && { cursor: { orderNo: opts.cursor }, skip: 1 }),
    select: { orderNo: true, status: true, shipName: true, shipCity: true, contactPhone: true, totalPaisa: true, placedAt: true, _count: { select: { items: true } } },
  });
  const items = rows.slice(0, opts.limit).map((o) => ({
    orderNo: o.orderNo, status: o.status, customer: o.shipName, city: o.shipCity, phone: o.contactPhone,
    totalPaisa: o.totalPaisa, itemCount: o._count.items, placedAt: o.placedAt.toISOString(),
  }));
  return { items, nextCursor: rows.length > opts.limit ? items.at(-1)!.orderNo : null };
}

/** Records a refund against the order's settled payment. */
export async function refund(orderNo: string, input: { amountPaisa: number; method: string; reference?: string; reason: string }, actorId: string) {
  const o = await prisma().order.findUnique({
    where: { orderNo },
    select: { id: true, payments: { where: { status: { in: ['PAID', 'COLLECTED', 'PARTIALLY_REFUNDED'] } }, select: { id: true, amountPaisa: true, refunds: { select: { amountPaisa: true } } } } },
  });
  if (!o) throw new NotFoundError('Order not found');
  const pay = o.payments[0];
  if (!pay) throw new DomainError('VALIDATION', 'There is no collected payment to refund on this order');
  const refunded = pay.refunds.reduce((a, r) => a + r.amountPaisa, 0);
  if (input.amountPaisa <= 0 || refunded + input.amountPaisa > pay.amountPaisa)
    throw new ValidationError({ amountPaisa: `You can refund at most ${(pay.amountPaisa - refunded) / 100} rupees` });
  const full = refunded + input.amountPaisa === pay.amountPaisa;
  await prisma().$transaction([
    prisma().refund.create({ data: { paymentId: pay.id, amountPaisa: input.amountPaisa, method: input.method, reference: input.reference, reason: input.reason, actorId } }),
    prisma().payment.update({ where: { id: pay.id }, data: { status: full ? 'REFUNDED' : 'PARTIALLY_REFUNDED' } }),
  ]);
  const ord = await prisma().order.findUnique({ where: { orderNo }, select: { contactEmail: true, shipName: true, totalPaisa: true, userId: true } });
  if (ord) orderEmails.refunded({ orderNo, email: ord.contactEmail, name: ord.shipName.split(' ')[0]!, totalPaisa: ord.totalPaisa, amountPaisa: input.amountPaisa, trackUrl: trackUrl(orderNo, ord.userId ? null : guestTokenFor(orderNo)) });
  return orderView(orderNo, { forCustomer: false });
}

/** Daily job: DELIVERED → COMPLETED once the return window has passed without a return. */
export async function completeDeliveredOrders() {
  const { returnWindowDays } = await getConfig();
  const cutoff = new Date(Date.now() - returnWindowDays * 86_400_000);
  const due = await prisma().order.findMany({ where: { status: 'DELIVERED', deliveredAt: { lte: cutoff } }, select: { orderNo: true } });
  let completed = 0;
  for (const o of due) {
    try {
      await transition(o.orderNo, 'COMPLETED', { type: 'SYSTEM' }, { note: `${returnWindowDays}-day return window elapsed` });
      completed++;
    } catch (err) {
      logger.error({ err, orderNo: o.orderNo }, 'auto-complete failed'); // one bad row never blocks the sweep
    }
  }
  return { due: due.length, completed };
}
