import type { Prisma } from '../generated/prisma/client.js';
import { prisma, type Tx } from '../db.js';
import { NotFoundError, StockConflictError, VariantGoneError } from '../http/errors.js';
import { getConfig } from './config.service.js';

/**
 * Carts (docs/ECOMMERCE_CORE/CART_FLOW.md). A cart is a scratchpad: it holds
 * no stock and locks no price. Every read re-resolves each line — current
 * price always wins, quantities clamp to stock, gone items are flagged.
 */

export type CartOwner = { userId: string } | { anonId: string };

const ownerWhere = (o: CartOwner) => ('userId' in o ? { userId: o.userId } : { anonId: o.anonId });

async function findCart(o: CartOwner, db: Tx | ReturnType<typeof prisma> = prisma()) {
  return db.cart.findUnique({ where: ownerWhere(o) as { userId: string } | { anonId: string }, select: { id: true } });
}

async function ensureCart(o: CartOwner) {
  const existing = await findCart(o);
  if (existing) return existing.id;
  const created = await prisma().cart.upsert({ where: ownerWhere(o) as { userId: string }, create: ownerWhere(o), update: {}, select: { id: true } });
  return created.id;
}

const lineSelect = {
  id: true,
  qty: true,
  addedPricePaisa: true,
  variant: {
    select: {
      id: true,
      sku: true,
      stock: true,
      color: true,
      archived: true,
      pricePaisa: true,
      size: { select: { label: true } },
      product: {
        select: {
          slug: true,
          name: true,
          status: true,
          pricePaisa: true,
          category: { select: { sizeMode: true, isActive: true } },
          images: { orderBy: [{ isCover: 'desc' }, { sortOrder: 'asc' }], take: 1, select: { url: true, altText: true } },
          attributes: { where: { definition: { key: 'colour' } }, select: { value: true } },
        },
      },
    },
  },
} satisfies Prisma.CartItemSelect;

export type CartLineStatus = 'ok' | 'removed' | 'out_of_stock';
export type CartLineView = {
  id: string;
  variantId: string;
  qty: number;
  status: CartLineStatus;
  notices: ('clamped' | 'price_up' | 'price_down')[];
  unitPricePaisa: number;
  linePaisa: number;
  available: number;
  size: string | null;
  color: string | null;
  product: { slug: string; name: string; mode: string; colour: string | null; image: { url: string; alt: string } | null };
};
export type CartView = { id: string | null; lines: CartLineView[]; count: number; subtotalPaisa: number; canCheckout: boolean; maxQtyPerLine: number };

/** Full revalidation (applies clamps and acknowledges price changes as it goes). */
export async function getCart(o: CartOwner): Promise<CartView> {
  const cfg = await getConfig();
  const cart = await findCart(o);
  if (!cart) return { id: null, lines: [], count: 0, subtotalPaisa: 0, canCheckout: false, maxQtyPerLine: cfg.maxQtyPerLine };
  const db = prisma();
  const rows = await db.cartItem.findMany({ where: { cartId: cart.id }, orderBy: { addedAt: 'asc' }, select: lineSelect });

  const lines: CartLineView[] = [];
  for (const r of rows) {
    const v = r.variant;
    const p = v.product;
    const unit = v.pricePaisa ?? p.pricePaisa;
    const gone = v.archived || p.status !== 'PUBLISHED' || !p.category.isActive;
    const notices: CartLineView['notices'] = [];
    let qty = r.qty;
    let status: CartLineStatus = 'ok';
    if (gone) status = 'removed';
    else if (v.stock <= 0) status = 'out_of_stock';
    else {
      const cap = Math.min(v.stock, cfg.maxQtyPerLine);
      if (qty > cap) {
        qty = cap;
        notices.push('clamped');
      }
      if (unit > r.addedPricePaisa) notices.push('price_up');
      if (unit < r.addedPricePaisa) notices.push('price_down');
      if (qty !== r.qty || unit !== r.addedPricePaisa) await db.cartItem.update({ where: { id: r.id }, data: { qty, addedPricePaisa: unit } });
    }
    const colour = p.attributes[0]?.value;
    lines.push({
      id: r.id,
      variantId: v.id,
      qty,
      status,
      notices,
      unitPricePaisa: unit,
      linePaisa: status === 'ok' ? unit * qty : 0,
      available: Math.max(0, v.stock),
      size: v.size?.label ?? null,
      color: v.color,
      product: {
        slug: p.slug,
        name: p.name,
        mode: p.category.sizeMode,
        colour: typeof colour === 'string' ? colour : null,
        image: p.images[0] ? { url: p.images[0].url, alt: p.images[0].altText } : null,
      },
    });
  }
  const valid = lines.filter((l) => l.status === 'ok');
  return {
    id: cart.id,
    lines,
    count: valid.reduce((a, l) => a + l.qty, 0),
    subtotalPaisa: valid.reduce((a, l) => a + l.linePaisa, 0),
    canCheckout: valid.length > 0 && valid.length === lines.length,
    maxQtyPerLine: cfg.maxQtyPerLine,
  };
}

async function sellableVariant(variantId: string) {
  const v = await prisma().productVariant.findUnique({
    where: { id: variantId },
    select: { id: true, stock: true, archived: true, pricePaisa: true, product: { select: { status: true, pricePaisa: true, category: { select: { isActive: true } } } } },
  });
  if (!v || v.archived || v.product.status !== 'PUBLISHED' || !v.product.category.isActive) throw new VariantGoneError();
  return { ...v, unit: v.pricePaisa ?? v.product.pricePaisa };
}

/** Adds (or increments) a line; clamps to stock and the per-line cap. */
export async function addLine(o: CartOwner, variantId: string, qty: number) {
  const [v, cfg] = await Promise.all([sellableVariant(variantId), getConfig()]);
  if (v.stock <= 0) throw new StockConflictError([{ variantId, requested: qty, available: 0 }]);
  const cartId = await ensureCart(o);
  const existing = await prisma().cartItem.findUnique({ where: { cartId_variantId: { cartId, variantId } }, select: { qty: true } });
  const wanted = (existing?.qty ?? 0) + qty;
  const finalQty = Math.min(wanted, v.stock, cfg.maxQtyPerLine);
  await prisma().cartItem.upsert({
    where: { cartId_variantId: { cartId, variantId } },
    create: { cartId, variantId, qty: finalQty, addedPricePaisa: v.unit },
    update: { qty: finalQty },
  });
  await prisma().cart.update({ where: { id: cartId }, data: { updatedAt: new Date() } });
  const cart = await getCart(o);
  return { cart, clamped: finalQty < wanted };
}

async function ownedLine(o: CartOwner, lineId: string) {
  const cart = await findCart(o);
  const line = cart && (await prisma().cartItem.findFirst({ where: { id: lineId, cartId: cart.id }, select: { id: true, variantId: true } }));
  if (!line) throw new NotFoundError('Cart line not found');
  return line;
}

export async function setLineQty(o: CartOwner, lineId: string, qty: number) {
  const line = await ownedLine(o, lineId);
  if (qty === 0) {
    await prisma().cartItem.delete({ where: { id: line.id } });
  } else {
    const [v, cfg] = await Promise.all([prisma().productVariant.findUnique({ where: { id: line.variantId }, select: { stock: true } }), getConfig()]);
    await prisma().cartItem.update({ where: { id: line.id }, data: { qty: Math.max(1, Math.min(qty, v?.stock ?? 0, cfg.maxQtyPerLine)) } });
  }
  return getCart(o);
}

export async function removeLine(o: CartOwner, lineId: string) {
  const line = await ownedLine(o, lineId);
  await prisma().cartItem.delete({ where: { id: line.id } });
  return getCart(o);
}

/**
 * Login merge: union by variant; on conflict the guest quantity wins (most
 * recent intent), clamped to stock. The guest cart is deleted. Returns a diff
 * for the one-time "we updated your cart" banner.
 */
export async function mergeGuestCart(anonId: string, userId: string) {
  const db = prisma();
  const guest = await db.cart.findUnique({ where: { anonId }, select: { id: true, items: { select: { variantId: true, qty: true, addedPricePaisa: true } } } });
  if (!guest || !guest.items.length) {
    if (guest) await db.cart.delete({ where: { id: guest.id } });
    return { changes: [] as { variantId: string; change: 'clamped' | 'removed' }[] };
  }
  const cfg = await getConfig();
  const userCartId = await ensureCart({ userId });
  const changes: { variantId: string; change: 'clamped' | 'removed' }[] = [];
  for (const item of guest.items) {
    const v = await sellableVariant(item.variantId).catch(() => null);
    if (!v || v.stock <= 0) {
      changes.push({ variantId: item.variantId, change: 'removed' });
      continue;
    }
    const qty = Math.min(item.qty, v.stock, cfg.maxQtyPerLine);
    if (qty < item.qty) changes.push({ variantId: item.variantId, change: 'clamped' });
    await db.cartItem.upsert({
      where: { cartId_variantId: { cartId: userCartId, variantId: item.variantId } },
      create: { cartId: userCartId, variantId: item.variantId, qty, addedPricePaisa: item.addedPricePaisa },
      update: { qty },
    });
  }
  await db.cart.delete({ where: { id: guest.id } });
  return { changes };
}

/** Clears a cart inside the order transaction. */
export async function clearCartTx(tx: Tx, cartId: string) {
  await tx.cartItem.deleteMany({ where: { cartId } });
}
