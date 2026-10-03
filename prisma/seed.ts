/**
 * Idempotent development seed (PRISMA_GUIDELINES.md §Seeding): upserts by
 * natural keys. Demo products use the DEMO- code prefix so they can be removed
 * surgically before launch (`npm run db:purge-demo`).
 *
 *   npm run db:seed
 */
import { hashPassword } from '../src/auth/password.js';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import { CONFIG_DEFAULTS } from '../src/services/config.service.js';

type Db = PrismaClient;

const SIZES = ['XS', 'S', 'M', 'L', 'XL', 'FREE'];

// Garment measurements in inches (flat-lay, full circumference).
const CHARTS: { name: string; dimensions: string[]; rows: Record<string, number[]> }[] = [
  {
    name: 'Kameez Default',
    dimensions: ['chest', 'waist', 'hip', 'shoulder', 'sleeve', 'length'],
    rows: { XS: [36, 32, 40, 13.5, 21, 40], S: [38, 34, 42, 14, 21.5, 40.5], M: [40, 36, 44, 14.5, 22, 41], L: [43, 39, 47, 15, 22.5, 41.5], XL: [46, 42, 50, 15.5, 23, 42] },
  },
  {
    name: 'Trousers Default',
    dimensions: ['waist', 'hip', 'length', 'ankle'],
    rows: { XS: [26, 40, 37, 13], S: [28, 42, 37.5, 13.5], M: [30, 44, 38, 14], L: [32, 46, 38.5, 14.5], XL: [34, 48, 39, 15] },
  },
  {
    name: 'Formals Default',
    dimensions: ['chest', 'waist', 'hip', 'shoulder', 'sleeve', 'length'],
    rows: { XS: [36, 32, 40, 13.5, 21, 43], S: [38, 34, 42, 14, 21.5, 43.5], M: [40, 36, 44, 14.5, 22, 44], L: [43, 39, 47, 15, 22.5, 44.5], XL: [46, 42, 50, 15.5, 23, 45] },
  },
  {
    name: 'Maxi & Gown Default',
    dimensions: ['bust', 'waist', 'length'],
    rows: { XS: [34, 28, 54], S: [36, 30, 54.5], M: [38, 32, 55], L: [41, 35, 55.5], XL: [44, 38, 56] },
  },
  {
    name: 'Lehenga Default',
    dimensions: ['bust', 'waist', 'length', 'flare'],
    rows: { XS: [34, 26, 40, 120], S: [36, 28, 40.5, 124], M: [38, 30, 41, 128], L: [41, 33, 41.5, 132], XL: [44, 36, 42, 136] },
  },
];

const FABRICS = ['Lawn', 'Cambric', 'Khaddar', 'Cotton', 'Silk', 'Raw silk', 'Chiffon', 'Organza', 'Jacquard', 'Net'];

type CatSeed = { slug: string; name: string; sizeMode: 'STITCHED' | 'UNSTITCHED' | 'NONE'; chart?: string; description?: string; active?: boolean; children?: CatSeed[] };

// CATEGORY_TAXONOMY.md §The tree (v1). Slugs are globally unique.
const TREE: CatSeed[] = [
  {
    slug: 'unstitched', name: 'Unstitched', sizeMode: 'UNSTITCHED',
    description: 'Lawn, cambric and khaddar suits with exact yardage listed for every piece, so your tailor knows what they’re working with.',
    children: [
      { slug: 'unstitched-3-piece', name: '3-Piece Suits', sizeMode: 'UNSTITCHED' },
      { slug: 'unstitched-2-piece', name: '2-Piece Suits', sizeMode: 'UNSTITCHED' },
      { slug: 'unstitched-1-piece', name: '1-Piece / Kurti Fabric', sizeMode: 'UNSTITCHED' },
    ],
  },
  {
    slug: 'ready-to-wear', name: 'Ready to Wear', sizeMode: 'STITCHED', chart: 'Kameez Default',
    description: 'Stitched pret with real garment measurements in inches on every product.',
    children: [
      { slug: 'rtw-kurtis', name: 'Kurtis', sizeMode: 'STITCHED' },
      { slug: 'rtw-2-piece', name: '2-Piece Suits', sizeMode: 'STITCHED' },
      { slug: 'rtw-3-piece', name: '3-Piece Suits', sizeMode: 'STITCHED' },
      { slug: 'rtw-co-ords', name: 'Co-ord Sets', sizeMode: 'STITCHED' },
      {
        slug: 'rtw-bottoms-dupattas', name: 'Bottoms & Dupattas', sizeMode: 'STITCHED',
        children: [
          { slug: 'rtw-trousers', name: 'Trousers & Shalwars', sizeMode: 'STITCHED', chart: 'Trousers Default' },
          { slug: 'rtw-dupattas', name: 'Dupattas & Shawls', sizeMode: 'NONE' },
        ],
      },
    ],
  },
  {
    slug: 'formals', name: 'Formals', sizeMode: 'STITCHED', chart: 'Formals Default',
    description: 'Semi-formal to luxury, measured and described as plainly as our everyday pieces.',
    children: [
      { slug: 'formals-semi-formal', name: 'Semi-Formal', sizeMode: 'STITCHED' },
      { slug: 'formals-luxury', name: 'Luxury Formal', sizeMode: 'STITCHED' },
      { slug: 'formals-maxis', name: 'Maxis & Gowns', sizeMode: 'STITCHED', chart: 'Maxi & Gown Default' },
      { slug: 'formals-lehenga', name: 'Lehenga Choli', sizeMode: 'STITCHED', chart: 'Lehenga Default' },
      { slug: 'formals-sarees', name: 'Sarees', sizeMode: 'UNSTITCHED' },
    ],
  },
  {
    slug: 'bridal', name: 'Bridal', sizeMode: 'STITCHED', chart: 'Formals Default', active: false,
    description: 'Bridal lehengas, maxis and nikkah edits.',
    children: [
      { slug: 'bridal-lehengas', name: 'Bridal Lehengas', sizeMode: 'STITCHED', chart: 'Lehenga Default', active: false },
      { slug: 'bridal-maxis', name: 'Bridal Maxis & Gowns', sizeMode: 'STITCHED', chart: 'Maxi & Gown Default', active: false },
      { slug: 'bridal-walima-nikkah', name: 'Walima / Nikkah Edits', sizeMode: 'STITCHED', active: false },
    ],
  },
];

// [city, zone, fee (PKR), estimate, express]
const ZONES: [string, string, number, string, boolean][] = [
  ['Karachi', 'A', 250, '1–2 working days', true],
  ['Lahore', 'A', 250, '2–3 working days', true],
  ['Islamabad', 'A', 250, '2–3 working days', true],
  ['Rawalpindi', 'B', 250, '2–3 working days', false],
  ['Faisalabad', 'B', 250, '3–5 working days', false],
  ['Multan', 'B', 250, '3–5 working days', false],
  ['Peshawar', 'B', 250, '3–5 working days', false],
  ['Hyderabad', 'B', 250, '2–4 working days', false],
  ['Quetta', 'C', 250, '3–5 working days', false],
  ['Sialkot', 'B', 250, '3–5 working days', false],
  ['Gujranwala', 'B', 250, '3–5 working days', false],
  ['Other city', 'C', 250, '3–5 working days', false],
  ['AJK / Gilgit-Baltistan', 'D', 350, '5–7 working days', false],
];

type DemoProduct = {
  code: string; slug: string; name: string; category: string; fabric: string; colour: string; work: string;
  price: number; compareAt?: number; daysAgo: number; lengthIn?: number;
  stock: number | [number, number, number, number, number]; description: string;
};

// The storefront's demo catalogue (prices in rupees here; stored as paisa).
const PRODUCTS: DemoProduct[] = [
  { code: 'DEMO-01', slug: 'gulnar', name: 'Gulnar — Embroidered Lawn 3-Piece (Unstitched)', category: 'unstitched-3-piece', fabric: 'Lawn', colour: 'Mustard', work: 'Embroidered', price: 6450, daysAgo: 2, stock: 24, description: 'Mustard lawn with a thread-embroidered front and neckline, a printed chiffon dupatta and dyed cambric for the trouser.' },
  { code: 'DEMO-02', slug: 'noor', name: 'Noor — Chikankari Kurti, Ivory', category: 'rtw-kurtis', fabric: 'Cotton', colour: 'Ivory', work: 'Chikankari', price: 3950, daysAgo: 3, lengthIn: 38, stock: [3, 8, 10, 7, 4], description: 'Hand-finished chikankari on soft cotton, in a straight cut that sits just below the knee.' },
  { code: 'DEMO-03', slug: 'mahjabeen', name: 'Mahjabeen — Cambric 2-Piece Pret', category: 'rtw-2-piece', fabric: 'Cambric', colour: 'Sage', work: 'Printed', price: 7250, daysAgo: 5, lengthIn: 42, stock: [4, 6, 9, 5, 2], description: 'Printed cambric shirt with a matching straight trouser. Mid-weight, made for autumn evenings.' },
  { code: 'DEMO-04', slug: 'zeenat', name: 'Zeenat — Silk Co-ord Set, Emerald', category: 'rtw-co-ords', fabric: 'Silk', colour: 'Emerald', work: 'Plain', price: 9800, daysAgo: 6, lengthIn: 30, stock: [2, 5, 6, 4, 3], description: 'Raw-silk shirt and wide-leg pant in deep emerald, cut to wear together or apart.' },
  { code: 'DEMO-05', slug: 'rania', name: 'Rania — Printed Lawn 2-Piece (Unstitched)', category: 'unstitched-2-piece', fabric: 'Lawn', colour: 'Deep blue', work: 'Printed', price: 4250, daysAgo: 8, stock: 18, description: 'Digitally printed lawn shirt with dyed trouser fabric. Light enough for Karachi summers.' },
  { code: 'DEMO-06', slug: 'farasha', name: 'Farasha — Organza Semi-Formal Suit', category: 'formals-semi-formal', fabric: 'Organza', colour: 'Mustard', work: 'Embroidered', price: 14500, daysAgo: 9, lengthIn: 44, stock: [2, 4, 5, 3, 1], description: 'Embroidered organza shirt over a silk slip, with a matching organza dupatta and raw-silk trouser.' },
  { code: 'DEMO-07', slug: 'sitara', name: 'Sitara — Khaddar Kurti, Rust', category: 'rtw-kurtis', fabric: 'Khaddar', colour: 'Rust', work: 'Block print', price: 3900, compareAt: 5200, daysAgo: 12, lengthIn: 40, stock: [0, 3, 5, 4, 2], description: 'Warm khaddar kurti with block-print detailing at the yoke and cuffs.' },
  { code: 'DEMO-08', slug: 'dilnaz', name: 'Dilnaz — Maxi, Tea Pink', category: 'formals-maxis', fabric: 'Chiffon', colour: 'Tea pink', work: 'Embellished', price: 18900, daysAgo: 14, lengthIn: 54, stock: [0, 1, 1, 0, 0], description: 'Floor-length chiffon maxi with a fully lined bodice and hand-set sequins on the sleeves.' },
  { code: 'DEMO-09', slug: 'mehr', name: 'Mehr — Printed Lawn Kurti Fabric (Unstitched)', category: 'unstitched-1-piece', fabric: 'Lawn', colour: 'Sage', work: 'Printed', price: 3450, daysAgo: 21, stock: 30, description: 'A single 3-yard piece of printed lawn, enough for a kurti or a long shirt.' },
  { code: 'DEMO-10', slug: 'ayesha', name: 'Ayesha — Embroidered Khaddar 3-Piece (Unstitched)', category: 'unstitched-3-piece', fabric: 'Khaddar', colour: 'Rust', work: 'Embroidered', price: 7950, daysAgo: 30, stock: 11, description: 'Embroidered khaddar shirt with a printed wool-blend shawl and dyed khaddar for the trouser.' },
  { code: 'DEMO-11', slug: 'hania', name: 'Hania — Lawn 3-Piece Pret', category: 'rtw-3-piece', fabric: 'Lawn', colour: 'Deep blue', work: 'Printed', price: 8450, daysAgo: 18, lengthIn: 42, stock: [3, 6, 8, 6, 3], description: 'Stitched lawn shirt, dupatta and cigarette trouser, ready to wear the day it arrives.' },
  { code: 'DEMO-12', slug: 'shireen', name: 'Shireen — Chiffon Luxury Formal', category: 'formals-luxury', fabric: 'Chiffon', colour: 'Emerald', work: 'Embellished', price: 24500, daysAgo: 26, lengthIn: 46, stock: [1, 3, 3, 2, 1], description: 'Hand-embellished chiffon shirt with a zari-bordered dupatta and jamawar trouser.' },
  { code: 'DEMO-13', slug: 'sana', name: 'Sana — Cambric Straight Trouser', category: 'rtw-trousers', fabric: 'Cambric', colour: 'Sage', work: 'Plain', price: 2450, daysAgo: 33, stock: [5, 10, 12, 8, 5], description: 'A straight trouser in mid-weight cambric with an elasticated back waist and side pocket.' },
  { code: 'DEMO-14', slug: 'roshan', name: 'Roshan — Printed Lawn 3-Piece (Unstitched)', category: 'unstitched-3-piece', fabric: 'Lawn', colour: 'Tea pink', work: 'Printed', price: 4450, compareAt: 5650, daysAgo: 40, stock: 6, description: 'All-over printed lawn shirt with a printed chiffon dupatta and dyed cambric for the trouser.' },
  { code: 'DEMO-15', slug: 'parveen', name: 'Parveen — Raw Silk Lehenga Choli', category: 'formals-lehenga', fabric: 'Raw silk', colour: 'Deep blue', work: 'Embroidered', price: 38500, daysAgo: 36, stock: [1, 2, 2, 1, 0], description: 'Raw-silk lehenga with a hand-embroidered choli and net dupatta. Made in small batches.' },
  { code: 'DEMO-16', slug: 'bano', name: 'Bano — Jacquard Semi-Formal Kurta', category: 'formals-semi-formal', fabric: 'Jacquard', colour: 'Rust', work: 'Embroidered', price: 9800, daysAgo: 28, lengthIn: 44, stock: [2, 4, 6, 4, 2], description: 'Self-woven jacquard kurta with a tilla-embroidered neckline and straight trouser.' },
];

const YARD_M = 0.9144;
const m = (yards: number) => Math.round(yards * YARD_M * 10) / 10;

/** "What's in the pack" for unstitched demo products. */
function packFor(p: DemoProduct) {
  const f = p.fabric.toLowerCase();
  const khaddar = f === 'khaddar';
  if (p.category === 'unstitched-3-piece')
    return [
      { piece: 'SHIRT' as const, detail: 'Shirt front', fabric: `${p.work === 'Embroidered' ? 'Embroidered' : 'Printed'} ${f}`, lengthMeters: m(1.25) },
      { piece: 'SHIRT' as const, detail: 'Back & sleeves', fabric: `Printed ${f}`, lengthMeters: m(1.75) },
      { piece: 'DUPATTA' as const, detail: 'Dupatta', fabric: khaddar ? 'Printed wool-blend shawl' : 'Printed chiffon', lengthMeters: m(2.5) },
      { piece: 'TROUSER' as const, detail: 'Trouser', fabric: khaddar ? 'Dyed khaddar' : 'Dyed cambric', lengthMeters: m(2.5) },
    ];
  if (p.category === 'unstitched-2-piece')
    return [
      { piece: 'SHIRT' as const, detail: 'Shirt', fabric: `Printed ${f}`, lengthMeters: m(3) },
      { piece: 'TROUSER' as const, detail: 'Trouser', fabric: 'Dyed cambric', lengthMeters: m(2.5) },
    ];
  return [{ piece: 'SHIRT' as const, detail: 'Shirt', fabric: `Printed ${f}`, lengthMeters: m(3) }];
}

export async function seed(db: Db, opts: { adminEmail?: string; adminPassword?: string; withDemoProducts?: boolean } = {}) {
  // Level 1: sizes
  for (const [i, label] of SIZES.entries()) await db.sizeDefinition.upsert({ where: { label }, create: { label, sortOrder: i }, update: { sortOrder: i } });
  const sizes = new Map((await db.sizeDefinition.findMany()).map((s) => [s.label, s.id]));

  // Level 2: charts
  const charts = new Map<string, string>();
  for (const c of CHARTS) {
    const chart = await db.sizeChart.upsert({ where: { name: c.name }, create: { name: c.name, dimensions: c.dimensions }, update: { dimensions: c.dimensions } });
    charts.set(c.name, chart.id);
    for (const [size, values] of Object.entries(c.rows))
      for (const [k, dimension] of c.dimensions.entries())
        await db.sizeChartCell.upsert({
          where: { chartId_sizeId_dimension: { chartId: chart.id, sizeId: sizes.get(size)!, dimension } },
          create: { chartId: chart.id, sizeId: sizes.get(size)!, dimension, valueInches: values[k]! },
          update: { valueInches: values[k]! },
        });
  }

  // Attribute set
  const set = await db.attributeSet.upsert({ where: { name: 'Eastern wear' }, create: { name: 'Eastern wear' }, update: {} });
  const defs: { key: string; label: string; type: 'SELECT' | 'TEXT' | 'MULTI_SELECT'; filterable: boolean; required: boolean; options?: string[] }[] = [
    { key: 'fabric', label: 'Fabric', type: 'SELECT', filterable: true, required: true, options: FABRICS },
    { key: 'colour', label: 'Colour', type: 'TEXT', filterable: true, required: true },
    { key: 'work', label: 'Work', type: 'SELECT', filterable: true, required: false, options: ['Plain', 'Printed', 'Block print', 'Embroidered', 'Chikankari', 'Embellished'] },
    { key: 'occasion', label: 'Occasion', type: 'MULTI_SELECT', filterable: true, required: false, options: ['Everyday', 'Office', 'Festive', 'Wedding'] },
  ];
  const defIds = new Map<string, string>();
  for (const [i, d] of defs.entries()) {
    const def = await db.attributeDefinition.upsert({
      where: { setId_key: { setId: set.id, key: d.key } },
      create: { setId: set.id, key: d.key, label: d.label, type: d.type, filterable: d.filterable, required: d.required, sortOrder: i },
      update: { label: d.label, type: d.type, filterable: d.filterable, required: d.required, sortOrder: i },
    });
    defIds.set(d.key, def.id);
    for (const [j, value] of (d.options ?? []).entries())
      await db.attributeValueOption.upsert({ where: { definitionId_value: { definitionId: def.id, value } }, create: { definitionId: def.id, value, label: value, sortOrder: j }, update: { sortOrder: j } });
  }

  // Categories
  const catIds = new Map<string, string>();
  const upsertCat = async (c: CatSeed, parentId: string | null, sortOrder: number) => {
    const data = {
      name: c.name, parentId, sortOrder, sizeMode: c.sizeMode, description: c.description ?? null,
      sizeChartId: c.chart ? charts.get(c.chart)! : null, attributeSetId: set.id, isActive: c.active ?? true,
    };
    const row = await db.category.upsert({ where: { slug: c.slug }, create: { slug: c.slug, ...data }, update: data });
    catIds.set(c.slug, row.id);
    for (const [i, child] of (c.children ?? []).entries()) await upsertCat(child, row.id, i);
  };
  for (const [i, c] of TREE.entries()) await upsertCat(c, null, i);

  // Shipping zones + config
  for (const [i, [city, zone, fee, estimateText, expressAvailable]] of ZONES.entries())
    await db.shippingZone.upsert({ where: { city }, create: { city, zone, feePaisa: fee * 100, estimateText, expressAvailable, sortOrder: i }, update: { zone, feePaisa: fee * 100, estimateText, expressAvailable, sortOrder: i } });
  for (const [key, value] of Object.entries(CONFIG_DEFAULTS)) await db.storeConfig.upsert({ where: { key }, create: { key, value }, update: {} });

  // Auto collections
  await db.collection.upsert({ where: { slug: 'new' }, create: { slug: 'new', name: 'New in', type: 'AUTO_NEW' }, update: {} });
  await db.collection.upsert({ where: { slug: 'sale' }, create: { slug: 'sale', name: 'Sale', type: 'AUTO_SALE' }, update: {} });

  // Admin (no self-serve admin signup exists — seed or an existing admin only)
  if (opts.adminEmail && opts.adminPassword) {
    const email = opts.adminEmail.toLowerCase();
    const existing = await db.user.findUnique({ where: { email } });
    if (!existing) await db.user.create({ data: { email, name: 'Store Admin', role: 'ADMIN', passwordHash: await hashPassword(opts.adminPassword) } });
    else if (existing.role !== 'ADMIN') await db.user.update({ where: { email }, data: { role: 'ADMIN' } });
  }

  if (opts.withDemoProducts !== false) await seedDemoProducts(db, { sizes, defIds, catIds });
}

async function seedDemoProducts(db: Db, ctx: { sizes: Map<string, string>; defIds: Map<string, string>; catIds: Map<string, string> }) {
  for (const p of PRODUCTS) {
    const exists = await db.product.findUnique({ where: { code: p.code }, select: { id: true } });
    if (exists) continue; // stock moves only through the ledger — never re-seed an existing product
    const stitched = Array.isArray(p.stock);
    const product = await db.product.create({
      data: {
        code: p.code, slug: p.slug, name: p.name, description: p.description,
        categoryId: ctx.catIds.get(p.category)!,
        pricePaisa: p.price * 100, compareAtPaisa: p.compareAt ? p.compareAt * 100 : null,
        status: 'PUBLISHED', publishedAt: new Date(Date.now() - p.daysAgo * 86_400_000),
        fitNote: p.slug === 'noor' ? 'Slim cut through the chest — size up for a relaxed fit.' : null,
        attributes: {
          create: [
            { definitionId: ctx.defIds.get('fabric')!, value: p.fabric },
            { definitionId: ctx.defIds.get('colour')!, value: p.colour },
            { definitionId: ctx.defIds.get('work')!, value: p.work },
          ],
        },
        ...(!stitched && { fabricContents: { create: packFor(p).map((f, i) => ({ ...f, sortOrder: i })) } }),
      },
    });

    const variants = stitched
      ? (['XS', 'S', 'M', 'L', 'XL'] as const).map((size, i) => ({ sizeId: ctx.sizes.get(size)!, sku: `PSK-${p.code}-${size}`, stock: (p.stock as number[])[i]! }))
      : [{ sizeId: null, sku: `PSK-${p.code}`, stock: p.stock as number }];
    for (const v of variants) {
      const created = await db.productVariant.create({ data: { productId: product.id, sizeId: v.sizeId, sku: v.sku, stock: v.stock } });
      // Opening balance goes through the ledger so stock == Σ ledger from day one.
      if (v.stock > 0) await db.inventoryLedger.create({ data: { variantId: created.id, delta: v.stock, reason: 'opening stock (seed)', source: 'SYSTEM', balanceAfter: v.stock } });
    }

    // Level 3: this product's real lengths (graded ±0.5 in per size), plus a slim-cut example.
    if (p.lengthIn) {
      const lengthDim = p.category === 'formals-maxis' || p.category === 'formals-lehenga' ? 'length' : p.category === 'rtw-trousers' ? null : 'length';
      if (lengthDim)
        for (const [i, size] of (['XS', 'S', 'M', 'L', 'XL'] as const).entries())
          await db.productSizeOverride.create({ data: { productId: product.id, sizeId: ctx.sizes.get(size)!, dimension: lengthDim, valueInches: p.lengthIn + (i - 2) * 0.5 } });
    }
    if (p.slug === 'noor')
      for (const [size, chest] of [['M', 38], ['L', 40]] as const)
        await db.productSizeOverride.create({ data: { productId: product.id, sizeId: ctx.sizes.get(size)!, dimension: 'chest', valueInches: chest } });
  }
}

/** Removes DEMO- products that have never been ordered (pre-launch cleanup). */
export async function purgeDemo(db: Db) {
  const demo = await db.product.findMany({ where: { code: { startsWith: 'DEMO-' } }, select: { id: true, variants: { select: { _count: { select: { orderItems: true } } } } } });
  const removable = demo.filter((p) => p.variants.every((v) => v._count.orderItems === 0)).map((p) => p.id);
  await db.product.deleteMany({ where: { id: { in: removable } } });
  await db.product.updateMany({ where: { code: { startsWith: 'DEMO-' }, id: { notIn: removable } }, data: { status: 'ARCHIVED' } });
  return { deleted: removable.length, archived: demo.length - removable.length };
}

// CLI
if (process.argv[1]?.replace(/\\/g, '/').endsWith('prisma/seed.ts')) {
  const { createPrisma } = await import('../src/db.js');
  try {
    process.loadEnvFile();
  } catch {
    /* env from the environment */
  }
  const db = createPrisma(process.env.DATABASE_URL!);
  const purge = process.argv.includes('--purge-demo');
  try {
    if (purge) console.log('purged demo products', await purgeDemo(db));
    else {
      await seed(db, { adminEmail: process.env.SEED_ADMIN_EMAIL, adminPassword: process.env.SEED_ADMIN_PASSWORD });
      console.log('seed complete');
    }
  } finally {
    await db.$disconnect();
  }
}
