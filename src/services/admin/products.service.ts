import { createHash } from 'node:crypto';
import type { Prisma } from '../../generated/prisma/client.js';
import { env } from '../../config/env.js';
import { prisma } from '../../db.js';
import { DomainError, NotFoundError, ValidationError } from '../../http/errors.js';
import { chartIdForCategory } from '../sizing.service.js';
import { productDetail } from '../catalog.service.js';

/**
 * Admin product management (API_ENDPOINTS.md §Admin/Products,
 * PRODUCT_ATTRIBUTE_SYSTEM.md §Validation). Publishing runs the gates; drafts
 * can be saved incomplete.
 */

export const MIN_IMAGES_TO_PUBLISH = 3;

export const slugify = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);

const skuFor = (code: string, size?: string | null, color?: string | null) =>
  ['PSK', code, size, color?.toUpperCase().replace(/[^A-Z0-9]+/g, '')].filter(Boolean).join('-');

async function uniqueSlug(base: string, excludeId?: string) {
  const db = prisma();
  let slug = slugify(base) || 'product';
  for (let i = 2; await db.product.findFirst({ where: { slug, ...(excludeId && { id: { not: excludeId } }) }, select: { id: true } }); i++) slug = `${slugify(base)}-${i}`;
  return slug;
}

async function nextCode() {
  const last = await prisma().product.findFirst({ where: { code: { startsWith: 'P' } }, orderBy: { code: 'desc' }, select: { code: true } });
  const n = last ? Number(last.code.slice(1)) + 1 : 1;
  return `P${String(Number.isFinite(n) ? n : 1).padStart(4, '0')}`;
}

export type ProductInput = {
  categoryId: string;
  name: string;
  slug?: string;
  description: string;
  pricePaisa: number;
  compareAtPaisa?: number | null;
  fitNote?: string | null;
  isFinalSale?: boolean;
  attributes?: Record<string, unknown>;
  fabricContents?: { piece: 'SHIRT' | 'DUPATTA' | 'TROUSER'; detail?: string; fabric: string; lengthMeters: number }[];
};

async function categoryInfo(categoryId: string) {
  const c = await prisma().category.findUnique({
    where: { id: categoryId },
    select: { id: true, sizeMode: true, attributeSetId: true, attributeSet: { select: { definitions: { select: { id: true, key: true, required: true, type: true } } } } },
  });
  if (!c) throw new ValidationError({ categoryId: 'Choose a category' });
  return c;
}

/** Attribute values keyed by definition key → rows; unknown keys are rejected. */
function attributeRows(defs: { id: string; key: string; type: string }[], values: Record<string, unknown>) {
  return Object.entries(values)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([key, value]) => {
      const def = defs.find((d) => d.key === key);
      if (!def) throw new ValidationError({ [`attributes.${key}`]: 'Unknown attribute for this category' });
      return { definitionId: def.id, value: value as Prisma.InputJsonValue };
    });
}

function validatePrices(i: { pricePaisa?: number; compareAtPaisa?: number | null }) {
  if (i.compareAtPaisa != null && i.pricePaisa != null && i.compareAtPaisa <= i.pricePaisa)
    throw new ValidationError({ compareAtPaisa: 'The original price must be higher than the sale price' });
}

export async function createProduct(input: ProductInput) {
  validatePrices(input);
  const cat = await categoryInfo(input.categoryId);
  const code = await nextCode();
  const slug = await uniqueSlug(input.slug ?? input.name);
  const db = prisma();
  const p = await db.product.create({
    data: {
      categoryId: cat.id,
      name: input.name,
      slug,
      code,
      description: input.description,
      pricePaisa: input.pricePaisa,
      compareAtPaisa: input.compareAtPaisa ?? null,
      fitNote: input.fitNote ?? null,
      isFinalSale: input.isFinalSale ?? false,
      attributes: { create: attributeRows(cat.attributeSet?.definitions ?? [], input.attributes ?? {}) },
      fabricContents: { create: (input.fabricContents ?? []).map((f, i) => ({ ...f, sortOrder: i })) },
      // Unstitched / free-size products get their single default variant now.
      ...(cat.sizeMode !== 'STITCHED' && { variants: { create: { sku: skuFor(code), stock: 0 } } }),
    },
    select: { id: true },
  });
  return adminProduct(p.id);
}

export async function updateProduct(id: string, input: Partial<ProductInput> & { status?: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED' }) {
  const db = prisma();
  const current = await db.product.findUnique({ where: { id }, select: { id: true, categoryId: true, pricePaisa: true, compareAtPaisa: true, status: true, publishedAt: true } });
  if (!current) throw new NotFoundError('Product not found');
  validatePrices({ pricePaisa: input.pricePaisa ?? current.pricePaisa, compareAtPaisa: input.compareAtPaisa === undefined ? current.compareAtPaisa : input.compareAtPaisa });
  if (input.categoryId && input.categoryId !== current.categoryId) {
    const [from, to] = await Promise.all([categoryInfo(current.categoryId), categoryInfo(input.categoryId)]);
    if (from.sizeMode !== to.sizeMode) throw new ValidationError({ categoryId: 'Move products only between categories with the same size mode' });
  }
  const cat = await categoryInfo(input.categoryId ?? current.categoryId);

  await db.$transaction(async (tx) => {
    await tx.product.update({
      where: { id },
      data: {
        ...(input.categoryId && { categoryId: input.categoryId }),
        ...(input.name && { name: input.name }),
        ...(input.slug && { slug: await uniqueSlug(input.slug, id) }),
        ...(input.description && { description: input.description }),
        ...(input.pricePaisa !== undefined && { pricePaisa: input.pricePaisa }),
        ...(input.compareAtPaisa !== undefined && { compareAtPaisa: input.compareAtPaisa }),
        ...(input.fitNote !== undefined && { fitNote: input.fitNote }),
        ...(input.isFinalSale !== undefined && { isFinalSale: input.isFinalSale }),
      },
    });
    if (input.attributes) {
      await tx.productAttributeValue.deleteMany({ where: { productId: id } });
      await tx.productAttributeValue.createMany({ data: attributeRows(cat.attributeSet?.definitions ?? [], input.attributes).map((r) => ({ ...r, productId: id })) });
    }
    if (input.fabricContents) {
      await tx.fabricContent.deleteMany({ where: { productId: id } });
      await tx.fabricContent.createMany({ data: input.fabricContents.map((f, i) => ({ ...f, productId: id, sortOrder: i })) });
    }
  });

  if (input.status && input.status !== current.status) {
    if (input.status === 'PUBLISHED') await assertPublishable(id);
    await db.product.update({ where: { id }, data: { status: input.status, ...(input.status === 'PUBLISHED' && !current.publishedAt && { publishedAt: new Date() }) } });
  }
  return adminProduct(id);
}

/** Publish gates: ≥3 images with one cover, required attributes, mode-specific content. */
export async function assertPublishable(id: string) {
  const p = await prisma().product.findUnique({
    where: { id },
    select: {
      description: true,
      category: { select: { sizeMode: true, isActive: true, attributeSet: { select: { definitions: { where: { required: true }, select: { id: true, label: true, key: true } } } } } },
      images: { select: { isCover: true } },
      attributes: { select: { definitionId: true } },
      fabricContents: { select: { id: true } },
      variants: { where: { archived: false }, select: { id: true, sizeId: true } },
    },
  });
  if (!p) throw new NotFoundError('Product not found');
  const problems: Record<string, string> = {};
  if (p.images.length < MIN_IMAGES_TO_PUBLISH) problems.images = `Add at least ${MIN_IMAGES_TO_PUBLISH} images`;
  else if (!p.images.some((i) => i.isCover)) problems.images = 'Choose a cover image';
  if (p.description.length < 40) problems.description = 'Write at least 40 characters';
  for (const d of p.category.attributeSet?.definitions ?? [])
    if (!p.attributes.some((a) => a.definitionId === d.id)) problems[`attributes.${d.key}`] = `${d.label} is required`;
  if (p.category.sizeMode === 'UNSTITCHED' && !p.fabricContents.length) problems.fabricContents = 'List what’s in the pack';
  if (p.category.sizeMode === 'STITCHED' && !p.variants.some((v) => v.sizeId)) problems.variants = 'Offer at least one size';
  if (Object.keys(problems).length) throw new ValidationError(problems, 'This product isn’t ready to publish yet');
}

/**
 * Reconciles offered sizes/colours → variants. New combos are created with stock 0;
 * dropped ones are deleted, or archived if they have order history.
 */
export async function setVariants(id: string, variants: { size?: string | null; color?: string | null; pricePaisa?: number | null }[]) {
  const db = prisma();
  const p = await db.product.findUnique({
    where: { id },
    select: { code: true, category: { select: { sizeMode: true } }, variants: { select: { id: true, sizeId: true, color: true, archived: true, _count: { select: { orderItems: true } } } } },
  });
  if (!p) throw new NotFoundError('Product not found');
  const stitched = p.category.sizeMode === 'STITCHED';
  if (!stitched && (variants.length !== 1 || variants[0]?.size)) throw new ValidationError({ variants: 'Unstitched and free-size products have exactly one variant with no size' });
  if (stitched && variants.some((v) => !v.size)) throw new ValidationError({ variants: 'Every variant of a stitched product needs a size' });

  const sizes = await db.sizeDefinition.findMany({ select: { id: true, label: true } });
  const chartId = stitched ? await chartIdForCategory((await db.product.findUnique({ where: { id }, select: { categoryId: true } }))!.categoryId) : null;
  const chartSizes = chartId ? new Set((await db.sizeChartCell.findMany({ where: { chartId }, select: { sizeId: true }, distinct: ['sizeId'] })).map((c) => c.sizeId)) : null;

  const wanted = variants.map((v) => {
    const size = v.size ? sizes.find((s) => s.label === v.size) : null;
    if (v.size && !size) throw new ValidationError({ variants: `Unknown size ${v.size}` });
    if (size && chartSizes && !chartSizes.has(size.id)) throw new ValidationError({ variants: `Size ${size.label} isn’t in this category’s size chart` });
    return { sizeId: size?.id ?? null, sizeLabel: size?.label ?? null, color: v.color?.trim() || null, pricePaisa: v.pricePaisa ?? null };
  });
  const key = (s: string | null, c: string | null) => `${s ?? ''}|${c ?? ''}`;
  if (new Set(wanted.map((w) => key(w.sizeId, w.color))).size !== wanted.length) throw new ValidationError({ variants: 'Each size and colour combination can appear only once' });

  await db.$transaction(async (tx) => {
    for (const w of wanted) {
      const existing = p.variants.find((v) => key(v.sizeId, v.color) === key(w.sizeId, w.color));
      if (existing) await tx.productVariant.update({ where: { id: existing.id }, data: { archived: false, pricePaisa: w.pricePaisa } });
      else await tx.productVariant.create({ data: { productId: id, sizeId: w.sizeId, color: w.color, pricePaisa: w.pricePaisa, sku: skuFor(p.code, w.sizeLabel, w.color), stock: 0 } });
    }
    for (const v of p.variants.filter((v) => !wanted.some((w) => key(w.sizeId, w.color) === key(v.sizeId, v.color)))) {
      if (v._count.orderItems > 0) await tx.productVariant.update({ where: { id: v.id }, data: { archived: true } });
      else await tx.productVariant.delete({ where: { id: v.id } });
    }
  });
  return adminProduct(id);
}

/** Level-3 overrides: sparse replace. (size, dimension) must exist in the bound chart; 10–80 inches. */
export async function setSizeOverrides(id: string, input: { overrides: { size: string; dimension: string; valueInches: number }[]; fitNote?: string | null }) {
  const db = prisma();
  const p = await db.product.findUnique({ where: { id }, select: { categoryId: true } });
  if (!p) throw new NotFoundError('Product not found');
  const chartId = await chartIdForCategory(p.categoryId);
  if (!chartId) throw new ValidationError({ overrides: 'This category has no size chart' });
  const chart = await db.sizeChart.findUnique({ where: { id: chartId }, select: { dimensions: true, cells: { select: { sizeId: true, dimension: true, size: { select: { label: true } } } } } });
  const rows = input.overrides.map((o, i) => {
    const cell = chart!.cells.find((c) => c.size.label === o.size && c.dimension === o.dimension);
    if (!cell) throw new ValidationError({ [`overrides.${i}`]: `${o.size} / ${o.dimension} isn’t in the size chart` });
    if (o.valueInches < 10 || o.valueInches > 80) throw new ValidationError({ [`overrides.${i}`]: 'Use a value between 10 and 80 inches' });
    return { productId: id, sizeId: cell.sizeId, dimension: o.dimension, valueInches: o.valueInches };
  });
  await db.$transaction([
    db.productSizeOverride.deleteMany({ where: { productId: id } }),
    db.productSizeOverride.createMany({ data: rows }),
    ...(input.fitNote !== undefined ? [db.product.update({ where: { id }, data: { fitNote: input.fitNote } })] : []),
  ]);
  return adminProduct(id);
}

const allowedImageUrl = (url: string) => {
  const cloud = env().CLOUDINARY_CLOUD_NAME;
  if (cloud) return url.startsWith(`https://res.cloudinary.com/${cloud}/`);
  return env().NODE_ENV !== 'production' && /^https:\/\//.test(url); // dev without Cloudinary
};

export async function setImages(id: string, images: { url: string; altText: string; isCover?: boolean }[]) {
  const db = prisma();
  if (!(await db.product.findUnique({ where: { id }, select: { id: true } }))) throw new NotFoundError('Product not found');
  images.forEach((img, i) => {
    if (!allowedImageUrl(img.url)) throw new ValidationError({ [`images.${i}.url`]: 'Upload images through the image uploader' });
    if (!img.altText.trim()) throw new ValidationError({ [`images.${i}.altText`]: 'Describe the image for screen readers' });
  });
  const coverIndex = Math.max(0, images.findIndex((i) => i.isCover));
  await db.$transaction([
    db.productImage.deleteMany({ where: { productId: id } }),
    db.productImage.createMany({ data: images.map((img, i) => ({ productId: id, url: img.url, altText: img.altText.trim(), sortOrder: i, isCover: i === coverIndex })) }),
  ]);
  return adminProduct(id);
}

/** Copies everything except stock (0) and status (DRAFT). */
export async function duplicateProduct(id: string) {
  const db = prisma();
  const src = await db.product.findUnique({
    where: { id },
    select: {
      categoryId: true, name: true, description: true, pricePaisa: true, compareAtPaisa: true, fitNote: true, isFinalSale: true,
      attributes: { select: { definitionId: true, value: true } },
      fabricContents: { select: { piece: true, detail: true, fabric: true, lengthMeters: true, sortOrder: true } },
      images: { select: { url: true, altText: true, sortOrder: true, isCover: true } },
      sizeOverrides: { select: { sizeId: true, dimension: true, valueInches: true } },
      variants: { where: { archived: false }, select: { sizeId: true, color: true, pricePaisa: true, size: { select: { label: true } } } },
    },
  });
  if (!src) throw new NotFoundError('Product not found');
  const code = await nextCode();
  const copy = await db.product.create({
    data: {
      categoryId: src.categoryId,
      name: `${src.name} (copy)`,
      slug: await uniqueSlug(`${src.name}-copy`),
      code,
      description: src.description,
      pricePaisa: src.pricePaisa,
      compareAtPaisa: src.compareAtPaisa,
      fitNote: src.fitNote,
      isFinalSale: src.isFinalSale,
      status: 'DRAFT',
      attributes: { create: src.attributes.map((a) => ({ definitionId: a.definitionId, value: a.value as Prisma.InputJsonValue })) },
      fabricContents: { create: src.fabricContents },
      images: { create: src.images },
      sizeOverrides: { create: src.sizeOverrides },
      variants: { create: src.variants.map((v) => ({ sizeId: v.sizeId, color: v.color, pricePaisa: v.pricePaisa, stock: 0, sku: skuFor(code, v.size?.label, v.color) })) },
    },
    select: { id: true },
  });
  return adminProduct(copy.id);
}

export async function archiveProduct(id: string) {
  const db = prisma();
  const p = await db.product.findUnique({ where: { id }, select: { variants: { select: { stock: true } } } });
  if (!p) throw new NotFoundError('Product not found');
  await db.product.update({ where: { id }, data: { status: 'ARCHIVED' } });
  const remaining = p.variants.reduce((a, v) => a + v.stock, 0);
  return { product: await adminProduct(id), warning: remaining ? `${remaining} units are still in stock on this product` : null };
}

export async function restoreProduct(id: string) {
  const p = await prisma().product.findUnique({ where: { id }, select: { status: true } });
  if (!p) throw new NotFoundError('Product not found');
  if (p.status !== 'ARCHIVED') throw new DomainError('VALIDATION', 'Only archived products can be restored');
  await prisma().product.update({ where: { id }, data: { status: 'DRAFT' } });
  return adminProduct(id);
}

export async function adminProduct(id: string) {
  const p = await prisma().product.findUnique({ where: { id }, select: { slug: true } });
  if (!p) throw new NotFoundError('Product not found');
  const detail = await productDetail(p.slug, { includeUnpublished: true });
  const stock = await prisma().productVariant.findMany({ where: { productId: id }, select: { id: true, sku: true, stock: true, archived: true, size: { select: { label: true } }, color: true } });
  const overrides = await prisma().productSizeOverride.findMany({ where: { productId: id }, select: { dimension: true, valueInches: true, size: { select: { label: true } } } });
  return {
    ...detail,
    allVariants: stock.map((v) => ({ id: v.id, sku: v.sku, stock: v.stock, archived: v.archived, size: v.size?.label ?? null, color: v.color })),
    sizeOverrides: overrides.map((o) => ({ size: o.size.label, dimension: o.dimension, valueInches: Number(o.valueInches) })),
  };
}

export async function adminListProducts(opts: { status?: string; q?: string; categoryId?: string; cursor?: string; limit: number }) {
  const where: Prisma.ProductWhereInput = {
    ...(opts.status && { status: opts.status as 'DRAFT' | 'PUBLISHED' | 'ARCHIVED' }),
    ...(opts.categoryId && { categoryId: opts.categoryId }),
    ...(opts.q && { OR: [{ name: { contains: opts.q, mode: 'insensitive' } }, { code: { contains: opts.q, mode: 'insensitive' } }] }),
  };
  const rows = await prisma().product.findMany({
    where,
    orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
    take: opts.limit + 1,
    ...(opts.cursor && { cursor: { id: opts.cursor }, skip: 1 }),
    select: { id: true, name: true, slug: true, code: true, status: true, pricePaisa: true, compareAtPaisa: true, category: { select: { name: true } }, variants: { select: { stock: true } }, _count: { select: { images: true } } },
  });
  const items = rows.slice(0, opts.limit).map((p) => ({
    id: p.id, name: p.name, slug: p.slug, code: p.code, status: p.status, pricePaisa: p.pricePaisa, compareAtPaisa: p.compareAtPaisa,
    category: p.category.name, stock: p.variants.reduce((a, v) => a + v.stock, 0), imageCount: p._count.images,
  }));
  return { items, nextCursor: rows.length > opts.limit ? items.at(-1)!.id : null };
}

/** Signed Cloudinary upload params — the browser uploads directly; the API never proxies bytes. */
export function signUpload(folder = 'products') {
  const { CLOUDINARY_CLOUD_NAME: cloudName, CLOUDINARY_API_KEY: apiKey, CLOUDINARY_API_SECRET: secret } = env();
  if (!cloudName || !apiKey || !secret) throw new DomainError('VALIDATION', 'Image uploads aren’t configured yet (set the CLOUDINARY_* variables)');
  const timestamp = Math.floor(Date.now() / 1000);
  const params = { folder: `poshak/${folder}`, timestamp };
  const toSign = Object.entries(params).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('&');
  const signature = createHash('sha1').update(toSign + secret).digest('hex');
  return { cloudName, apiKey, timestamp, folder: params.folder, signature, uploadUrl: `https://api.cloudinary.com/v1_1/${cloudName}/image/upload` };
}
