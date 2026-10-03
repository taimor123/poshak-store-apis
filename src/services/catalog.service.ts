import type { Prisma } from '../generated/prisma/client.js';
import { prisma } from '../db.js';
import { NotFoundError } from '../http/errors.js';
import { getConfig } from './config.service.js';
import { resolveChart } from './sizing.service.js';

/**
 * Public catalogue reads. Only PUBLISHED products in active categories are
 * visible. Returns DTOs, never raw rows (PRISMA_GUIDELINES.md §Query rules).
 *
 * Listing filters run in memory over the category subtree: the store has < 50
 * SKUs at launch (IMPLEMENTATION_PLAN.md). Move filtering into SQL before the
 * catalogue reaches a few thousand products.
 */

const YARDS_PER_METER = 1.0936;

// ─── Shared selection + mapping ─────────────────────────────────────────────

const cardSelect = {
  id: true,
  slug: true,
  name: true,
  code: true,
  pricePaisa: true,
  compareAtPaisa: true,
  publishedAt: true,
  isFinalSale: true,
  category: { select: { slug: true, name: true, sizeMode: true, parent: { select: { slug: true, name: true } } } },
  images: { orderBy: [{ isCover: 'desc' }, { sortOrder: 'asc' }], take: 1, select: { url: true, altText: true } },
  attributes: { select: { value: true, definition: { select: { key: true } } } },
  variants: {
    where: { archived: false },
    select: { id: true, stock: true, pricePaisa: true, color: true, size: { select: { label: true, sortOrder: true } } },
  },
} satisfies Prisma.ProductSelect;

type CardRow = Prisma.ProductGetPayload<{ select: typeof cardSelect }>;
export type SizeMode = 'STITCHED' | 'UNSTITCHED' | 'NONE';

export type ProductCard = {
  id: string;
  slug: string;
  name: string;
  code: string;
  mode: SizeMode;
  category: { slug: string; name: string };
  parentCategory: { slug: string; name: string } | null;
  pricePaisa: number;
  compareAtPaisa: number | null;
  badge: 'NEW' | 'SALE' | null;
  fabric: string | null;
  colour: string | null;
  image: { url: string; alt: string } | null;
  stock: { total: number; low: boolean };
  /** Stitched: one entry per offered size (in size order). */
  sizes: { label: string; stock: number; variantId: string }[];
  /** Unstitched / free-size: the single default variant. */
  variantId: string | null;
  publishedAt: string | null;
};

const attr = (row: { attributes: { value: unknown; definition: { key: string } }[] }, key: string) => {
  const v = row.attributes.find((a) => a.definition.key === key)?.value;
  return Array.isArray(v) ? (v as string[]) : typeof v === 'string' ? v : null;
};

/** ACTIVE, unexpired reservations per variant (dormant at the COD-only launch). */
async function reservedByVariant(variantIds: string[]) {
  if (!variantIds.length) return new Map<string, number>();
  const rows = await prisma().reservation.groupBy({
    by: ['variantId'],
    where: { variantId: { in: variantIds }, status: 'ACTIVE', expiresAt: { gt: new Date() } },
    _sum: { qty: true },
  });
  return new Map(rows.map((r) => [r.variantId, r._sum.qty ?? 0]));
}

function toCard(p: CardRow, reserved: Map<string, number>, cfg: { lowStockThreshold: number; newArrivalDays: number }): ProductCard {
  const avail = (v: { id: string; stock: number }) => Math.max(0, v.stock - (reserved.get(v.id) ?? 0));
  const total = p.variants.reduce((a, v) => a + avail(v), 0);
  const isNew = !!p.publishedAt && Date.now() - p.publishedAt.getTime() <= cfg.newArrivalDays * 86_400_000;
  const fabric = attr(p, 'fabric');
  const colour = attr(p, 'colour');
  return {
    id: p.id,
    slug: p.slug,
    name: p.name,
    code: p.code,
    mode: p.category.sizeMode,
    category: { slug: p.category.slug, name: p.category.name },
    parentCategory: p.category.parent,
    pricePaisa: p.pricePaisa,
    compareAtPaisa: p.compareAtPaisa,
    badge: p.compareAtPaisa ? 'SALE' : isNew ? 'NEW' : null,
    fabric: typeof fabric === 'string' ? fabric : null,
    colour: typeof colour === 'string' ? colour : null,
    image: p.images[0] ? { url: p.images[0].url, alt: p.images[0].altText } : null,
    stock: { total, low: total > 0 && total <= cfg.lowStockThreshold },
    sizes: p.variants
      .filter((v) => v.size)
      .sort((a, b) => a.size!.sortOrder - b.size!.sortOrder)
      .map((v) => ({ label: v.size!.label, stock: avail(v), variantId: v.id })),
    variantId: p.variants.length === 1 && !p.variants[0]!.size ? p.variants[0]!.id : null,
    publishedAt: p.publishedAt?.toISOString() ?? null,
  };
}

async function toCards(rows: CardRow[]) {
  const [cfg, reserved] = await Promise.all([getConfig(), reservedByVariant(rows.flatMap((r) => r.variants.map((v) => v.id)))]);
  return rows.map((r) => toCard(r, reserved, cfg));
}

const visible = { status: 'PUBLISHED', category: { isActive: true } } satisfies Prisma.ProductWhereInput;

// ─── Categories ─────────────────────────────────────────────────────────────

export type CategoryNode = { id: string; slug: string; name: string; description: string | null; sizeMode: SizeMode; children: CategoryNode[] };

export async function categoryTree(includeInactive = false): Promise<CategoryNode[]> {
  const rows = await prisma().category.findMany({
    where: includeInactive ? {} : { isActive: true },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    select: { id: true, slug: true, name: true, description: true, sizeMode: true, parentId: true },
  });
  const byParent = new Map<string | null, typeof rows>();
  for (const r of rows) byParent.set(r.parentId, [...(byParent.get(r.parentId) ?? []), r]);
  const build = (parentId: string | null): CategoryNode[] =>
    (byParent.get(parentId) ?? []).map((r) => ({ id: r.id, slug: r.slug, name: r.name, description: r.description, sizeMode: r.sizeMode, children: build(r.id) }));
  return build(null);
}

/** Resolves "ready-to-wear/rtw-kurtis" (or just the last segment) to an active category + all descendant ids. */
async function resolveCategoryPath(path: string) {
  const slugs = path.split('/').filter(Boolean);
  const leaf = slugs.at(-1);
  if (!leaf) throw new NotFoundError('Category not found');
  const all = await prisma().category.findMany({ where: { isActive: true }, select: { id: true, slug: true, name: true, description: true, parentId: true, sizeMode: true } });
  const cat = all.find((c) => c.slug === leaf);
  if (!cat) throw new NotFoundError('Category not found');
  const ids = [cat.id];
  for (let i = 0; i < ids.length; i++) for (const c of all) if (c.parentId === ids[i]) ids.push(c.id);
  const trail: { slug: string; name: string }[] = [];
  for (let c: (typeof all)[number] | undefined = cat; c; c = all.find((x) => x.id === c!.parentId)) trail.unshift({ slug: c.slug, name: c.name });
  const children = all.filter((c) => c.parentId === cat.id).map((c) => ({ slug: c.slug, name: c.name }));
  return { category: { slug: cat.slug, name: cat.name, description: cat.description, sizeMode: cat.sizeMode }, ids, trail, children };
}

// ─── Listing filters ────────────────────────────────────────────────────────

export const PRICE_BANDS = [
  { key: 'u5', label: 'Under PKR 5,000', min: 0, max: 4_999_99 },
  { key: '5-10', label: 'PKR 5,000 – 10,000', min: 5_000_00, max: 10_000_00 },
  { key: '10-20', label: 'PKR 10,000 – 20,000', min: 10_000_01, max: 20_000_00 },
  { key: 'o20', label: 'Over PKR 20,000', min: 20_000_01, max: Number.MAX_SAFE_INTEGER },
] as const;

export type ListingQuery = {
  fabric?: string[];
  price?: string;
  size?: string[];
  sale?: boolean;
  inStock?: boolean;
  sort?: 'new' | 'price_asc' | 'price_desc';
  cursor?: string;
  limit: number;
};

type Pred = (c: ProductCard) => boolean;
function predicates(q: ListingQuery) {
  const band = PRICE_BANDS.find((b) => b.key === q.price);
  return {
    fabric: ((c) => !q.fabric?.length || (!!c.fabric && q.fabric.includes(c.fabric))) as Pred,
    price: ((c) => !band || (c.pricePaisa >= band.min && c.pricePaisa <= band.max)) as Pred,
    // A product matches a size if an offered variant of that size is in stock (SIZE_SYSTEM.md §Filtering).
    size: ((c) => !q.size?.length || c.sizes.some((s) => q.size!.includes(s.label) && s.stock > 0)) as Pred,
    sale: ((c) => !q.sale || !!c.compareAtPaisa) as Pred,
    inStock: ((c) => !q.inStock || c.stock.total > 0) as Pred,
  };
}

const encodeCursor = (offset: number) => Buffer.from(String(offset)).toString('base64url');
const decodeCursor = (c?: string) => {
  const n = c ? Number(Buffer.from(c, 'base64url').toString()) : 0;
  return Number.isInteger(n) && n >= 0 ? n : 0;
};

/** Filters, facet counts (each facet ignores its own filter), sort and cursor pagination. */
export function applyListing(cards: ProductCard[], q: ListingQuery) {
  const p = predicates(q);
  const except = (skip: keyof typeof p) => cards.filter((c) => (Object.keys(p) as (keyof typeof p)[]).every((k) => k === skip || p[k](c)));
  const matched = cards.filter((c) => Object.values(p).every((f) => f(c)));

  const fabricBase = except('fabric');
  const fabrics = Array.from(new Set(cards.map((c) => c.fabric).filter((f): f is string => !!f)))
    .sort()
    .map((value) => ({ value, count: fabricBase.filter((c) => c.fabric === value).length }));
  const priceBase = except('price');
  const prices = PRICE_BANDS.map((b) => ({ value: b.key, label: b.label, count: priceBase.filter((c) => c.pricePaisa >= b.min && c.pricePaisa <= b.max).length }));
  const sizeBase = except('size');
  const sizeLabels = Array.from(new Map(cards.flatMap((c) => c.sizes.map((s) => [s.label, s.label] as const))).keys());
  const sizes = sizeLabels.map((value) => ({ value, count: sizeBase.filter((c) => c.sizes.some((s) => s.label === value && s.stock > 0)).length }));

  const sorted = [...matched].sort((a, b) => {
    // Sold-out products sort last (INVENTORY_FLOW.md §Stock states).
    const out = Number(a.stock.total === 0) - Number(b.stock.total === 0);
    if (out) return out;
    if (q.sort === 'price_asc') return a.pricePaisa - b.pricePaisa;
    if (q.sort === 'price_desc') return b.pricePaisa - a.pricePaisa;
    return (b.publishedAt ?? '').localeCompare(a.publishedAt ?? '');
  });
  const offset = decodeCursor(q.cursor);
  const items = sorted.slice(offset, offset + q.limit);
  const nextOffset = offset + items.length;
  return {
    items,
    total: sorted.length,
    nextCursor: nextOffset < sorted.length ? encodeCursor(nextOffset) : null,
    facets: { fabric: fabrics, price: prices, size: sizes, hasStitched: cards.some((c) => c.mode === 'STITCHED') },
  };
}

// ─── Public reads ───────────────────────────────────────────────────────────

export async function categoryListing(path: string, q: ListingQuery) {
  const { category, ids, trail, children } = await resolveCategoryPath(path);
  const rows = await prisma().product.findMany({ where: { ...visible, categoryId: { in: ids } }, select: cardSelect });
  const listing = applyListing(await toCards(rows), q);
  return { category, breadcrumbs: trail, children, ...listing };
}

/** Auto collections: "new" (published within newArrivalDays), "sale" (has compare-at), "all". */
export async function collectionListing(slug: string, q: ListingQuery) {
  const cfg = await getConfig();
  const where: Prisma.ProductWhereInput =
    slug === 'new'
      ? { publishedAt: { gte: new Date(Date.now() - cfg.newArrivalDays * 86_400_000) } }
      : slug === 'sale'
        ? { compareAtPaisa: { not: null } }
        : slug === 'all'
          ? {}
          : await manualCollectionWhere(slug);
  const rows = await prisma().product.findMany({ where: { ...visible, ...where }, select: cardSelect });
  const titles: Record<string, string> = { new: 'New in', sale: 'Sale', all: 'All clothing' };
  return { collection: { slug, name: titles[slug] ?? slug }, ...applyListing(await toCards(rows), q) };
}

async function manualCollectionWhere(slug: string): Promise<Prisma.ProductWhereInput> {
  const c = await prisma().collection.findUnique({ where: { slug }, select: { productIds: true, active: true } });
  if (!c?.active) throw new NotFoundError('Collection not found');
  return { id: { in: c.productIds } };
}

export async function productsBySlugs(slugs: string[]) {
  const rows = await prisma().product.findMany({ where: { ...visible, slug: { in: slugs } }, select: cardSelect });
  const cards = await toCards(rows);
  return slugs.map((s) => cards.find((c) => c.slug === s)).filter((c): c is ProductCard => !!c);
}

export async function productDetail(slug: string, opts: { includeUnpublished?: boolean } = {}) {
  const db = prisma();
  const p = await db.product.findUnique({
    where: { slug },
    select: {
      ...cardSelect,
      status: true,
      description: true,
      fitNote: true,
      categoryId: true,
      images: { orderBy: [{ isCover: 'desc' }, { sortOrder: 'asc' }], select: { url: true, altText: true, isCover: true } },
      fabricContents: { orderBy: { sortOrder: 'asc' }, select: { piece: true, detail: true, fabric: true, lengthMeters: true } },
      variants: {
        where: { archived: false },
        select: { id: true, sku: true, stock: true, pricePaisa: true, color: true, size: { select: { label: true, sortOrder: true } } },
      },
    },
  });
  if (!p || (!opts.includeUnpublished && p.status !== 'PUBLISHED')) throw new NotFoundError('Product not found');
  const [card] = await toCards([{ ...p, images: p.images.slice(0, 1) }]);
  const reserved = await reservedByVariant(p.variants.map((v) => v.id));
  const related = await db.product.findMany({
    where: { ...visible, categoryId: p.categoryId, id: { not: p.id } },
    orderBy: { publishedAt: 'desc' },
    take: 4,
    select: cardSelect,
  });

  return {
    ...card!,
    status: p.status,
    description: p.description,
    fitNote: p.fitNote,
    isFinalSale: p.isFinalSale,
    images: p.images.map((i) => ({ url: i.url, alt: i.altText, isCover: i.isCover })),
    attributes: Object.fromEntries(p.attributes.map((a) => [a.definition.key, a.value])),
    variants: p.variants
      .sort((a, b) => (a.size?.sortOrder ?? 0) - (b.size?.sortOrder ?? 0))
      .map((v) => ({
        id: v.id,
        sku: v.sku,
        size: v.size?.label ?? null,
        color: v.color,
        pricePaisa: v.pricePaisa ?? p.pricePaisa,
        available: Math.max(0, v.stock - (reserved.get(v.id) ?? 0)),
      })),
    sizeChart: await resolveChart(p.id),
    fabricContents: p.fabricContents.map((f) => ({
      piece: f.piece,
      detail: f.detail,
      fabric: f.fabric,
      lengthMeters: Number(f.lengthMeters),
      lengthYards: Math.round(Number(f.lengthMeters) * YARDS_PER_METER * 4) / 4,
    })),
    related: await toCards(related),
  };
}

/** Full-text search over name/code/description + fabric/colour/category names. */
export async function search(qRaw: string, q: ListingQuery) {
  const words = qRaw
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.replace(/[^a-z0-9-]/g, '').replace(/s$/, ''))
    .filter((w) => w.length >= 2)
    .slice(0, 8);
  if (!words.length) return { query: qRaw, ...applyListing([], q) };
  const tsQuery = words.map((w) => `${w.replace(/-/g, ' & ')}:*`).join(' & ');
  const like = words.map((w) => `%${w}%`);
  // Each word must match the text index OR an attribute / category name.
  const ids = await prisma().$queryRaw<{ id: string }[]>`
    SELECT p."id"
    FROM "Product" p
    JOIN "Category" c ON c."id" = p."categoryId"
    LEFT JOIN "Category" pc ON pc."id" = c."parentId"
    WHERE p."status" = 'PUBLISHED' AND c."isActive"
      AND (
        p."searchText" @@ to_tsquery('simple', ${tsQuery})
        OR (
          SELECT bool_and(
            lower(p."name") LIKE w
            OR lower(c."name") LIKE w
            OR lower(coalesce(pc."name", '')) LIKE w
            OR EXISTS (SELECT 1 FROM "ProductAttributeValue" av WHERE av."productId" = p."id" AND lower(av."value"::text) LIKE w)
          ) FROM unnest(${like}::text[]) AS w
        )
      )`;
  const rows = await prisma().product.findMany({ where: { id: { in: ids.map((r) => r.id) } }, select: cardSelect });
  return { query: qRaw, ...applyListing(await toCards(rows), q) };
}
