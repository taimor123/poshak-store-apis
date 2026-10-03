import type { Prisma } from '../generated/prisma/client.js';
import { prisma, type Tx } from '../db.js';
import { NotFoundError, StockConflictError, ValidationError } from '../http/errors.js';

/**
 * The ONLY writer of ProductVariant.stock (CLAUDE.md invariant 3,
 * docs/ECOMMERCE_CORE/INVENTORY_FLOW.md). Every movement is a conditional UPDATE
 * (never read-then-write) plus an append-only InventoryLedger row, in the
 * caller's transaction.
 */

export type LedgerSource = 'ORDER' | 'CANCEL' | 'RETURN' | 'ADMIN' | 'SYSTEM';
export type Adjustment = { variantId: string; delta: number; reason: string; source: LedgerSource; refId?: string; actorId?: string };

export const ADJUST_REASONS = ['recount', 'damaged', 'received-stock', 'photo-sample', 'other'] as const;

/**
 * Applies one stock movement inside `tx`. Decrements are guarded by
 * `stock + delta >= 0` in SQL, so concurrent orders can never oversell.
 * Throws StockConflictError when the guard fails.
 */
export async function adjust(tx: Tx, a: Adjustment): Promise<number> {
  if (!Number.isInteger(a.delta) || a.delta === 0) throw new ValidationError({ delta: 'Enter a non-zero whole number' });
  const rows = await tx.$queryRaw<{ stock: number }[]>`
    UPDATE "ProductVariant"
    SET "stock" = "stock" + ${a.delta}, "updatedAt" = now()
    WHERE "id" = ${a.variantId} AND "stock" + ${a.delta} >= 0
    RETURNING "stock"`;
  const balanceAfter = rows[0]?.stock;
  if (balanceAfter === undefined) {
    const v = await tx.productVariant.findUnique({ where: { id: a.variantId }, select: { stock: true } });
    if (!v) throw new NotFoundError('Variant not found');
    throw new StockConflictError([{ variantId: a.variantId, requested: -a.delta, available: v.stock }]);
  }
  await tx.inventoryLedger.create({
    data: { variantId: a.variantId, delta: a.delta, reason: a.reason, source: a.source, refId: a.refId, actorId: a.actorId, balanceAfter },
  });
  return balanceAfter;
}

/** Admin adjustment (POST /admin/inventory/adjust): its own transaction. */
export async function adminAdjust(input: { variantId: string; delta: number; reason: (typeof ADJUST_REASONS)[number]; note?: string }, actorId: string) {
  if (input.reason === 'other' && !input.note?.trim()) throw new ValidationError({ note: 'Add a note when the reason is “other”' });
  const reason = input.note ? `${input.reason}: ${input.note}` : input.reason;
  try {
    const balanceAfter = await prisma().$transaction((tx) => adjust(tx, { variantId: input.variantId, delta: input.delta, reason, source: 'ADMIN', actorId }));
    return { variantId: input.variantId, stock: balanceAfter };
  } catch (e) {
    if (e instanceof StockConflictError) throw new ValidationError({ delta: 'Stock can’t go below zero. Recount instead.' });
    throw e;
  }
}

/** Inventory table rows for admin. */
export async function listInventory(opts: { filter: 'low' | 'all'; lowStockThreshold: number; cursor?: string; limit: number; q?: string }) {
  const where: Prisma.ProductVariantWhereInput = {
    ...(opts.filter === 'low' && { stock: { lte: opts.lowStockThreshold } }),
    ...(opts.q && { OR: [{ sku: { contains: opts.q, mode: 'insensitive' } }, { product: { name: { contains: opts.q, mode: 'insensitive' } } }] }),
  };
  const rows = await prisma().productVariant.findMany({
    where,
    orderBy: [{ stock: 'asc' }, { id: 'asc' }],
    take: opts.limit + 1,
    ...(opts.cursor && { cursor: { id: opts.cursor }, skip: 1 }),
    select: {
      id: true, sku: true, stock: true, color: true, archived: true,
      size: { select: { label: true } },
      product: { select: { id: true, name: true, slug: true, status: true } },
    },
  });
  const hasMore = rows.length > opts.limit;
  const items = rows.slice(0, opts.limit).map((v) => ({
    variantId: v.id, sku: v.sku, stock: v.stock, available: v.stock, size: v.size?.label ?? null, color: v.color,
    archived: v.archived || v.product.status === 'ARCHIVED', product: { id: v.product.id, name: v.product.name, slug: v.product.slug },
  }));
  return { items, nextCursor: hasMore ? items.at(-1)?.variantId ?? null : null };
}

export async function ledgerFor(variantId: string, limit = 50) {
  return prisma().inventoryLedger.findMany({
    where: { variantId },
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: { id: true, delta: true, reason: true, source: true, refId: true, actorId: true, balanceAfter: true, createdAt: true },
  });
}

/** Nightly invariant check: variant.stock == Σ ledger.delta. Returns mismatches (never auto-heals). */
export async function auditLedger() {
  return prisma().$queryRaw<{ variantId: string; stock: number; ledgerSum: number }[]>`
    SELECT v."id" AS "variantId", v."stock", COALESCE(SUM(l."delta"), 0)::int AS "ledgerSum"
    FROM "ProductVariant" v
    LEFT JOIN "InventoryLedger" l ON l."variantId" = v."id"
    GROUP BY v."id", v."stock"
    HAVING v."stock" <> COALESCE(SUM(l."delta"), 0)`;
}
