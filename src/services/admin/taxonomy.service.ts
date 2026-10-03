import type { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../../db.js';
import { DomainError, NotFoundError, ValidationError } from '../../http/errors.js';
import { categoryTree } from '../catalog.service.js';
import { slugify } from './products.service.js';

/**
 * Categories, size charts, attribute sets, collections (CATEGORY_TAXONOMY.md §Admin guardrails).
 * Category changes never touch the storefront header — that's code-curated in the app.
 */

const MAX_DEPTH = 3;

async function depthOf(id: string | null): Promise<number> {
  let depth = 0;
  for (let cur = id; cur; depth++) cur = (await prisma().category.findUnique({ where: { id: cur }, select: { parentId: true } }))?.parentId ?? null;
  return depth;
}

export type CategoryInput = { name: string; slug?: string; parentId?: string | null; description?: string | null; sizeMode: 'STITCHED' | 'UNSTITCHED' | 'NONE'; sizeChartId?: string | null; attributeSetId?: string | null; sortOrder?: number; isActive?: boolean };

export async function createCategory(input: CategoryInput) {
  if ((await depthOf(input.parentId ?? null)) >= MAX_DEPTH) throw new ValidationError({ parentId: `Categories can be at most ${MAX_DEPTH} levels deep` });
  const slug = slugify(input.slug ?? input.name);
  if (await prisma().category.findUnique({ where: { slug }, select: { id: true } })) throw new ValidationError({ slug: 'That URL is already used by another category' });
  if (input.sizeMode !== 'STITCHED' && input.sizeChartId) throw new ValidationError({ sizeChartId: 'Only stitched categories have a size chart' });
  await prisma().category.create({ data: { ...input, slug } });
  return categoryTree(true);
}

export async function updateCategory(id: string, input: Partial<CategoryInput>) {
  const db = prisma();
  const c = await db.category.findUnique({ where: { id }, select: { sizeMode: true, _count: { select: { products: true } } } });
  if (!c) throw new NotFoundError('Category not found');
  if (input.sizeMode && input.sizeMode !== c.sizeMode && c._count.products > 0)
    throw new ValidationError({ sizeMode: 'Move this category’s products out before changing its size mode' });
  if (input.parentId !== undefined) {
    if (input.parentId === id) throw new ValidationError({ parentId: 'A category can’t be its own parent' });
    // No cycles: the new parent can't be a descendant.
    for (let cur = input.parentId; cur; cur = (await db.category.findUnique({ where: { id: cur }, select: { parentId: true } }))?.parentId ?? null)
      if (cur === id) throw new ValidationError({ parentId: 'That would put the category inside itself' });
    if ((await depthOf(input.parentId)) >= MAX_DEPTH) throw new ValidationError({ parentId: `Categories can be at most ${MAX_DEPTH} levels deep` });
  }
  const slug = input.slug ? slugify(input.slug) : undefined;
  if (slug && (await db.category.findFirst({ where: { slug, id: { not: id } }, select: { id: true } }))) throw new ValidationError({ slug: 'That URL is already used by another category' });
  await db.category.update({ where: { id }, data: { ...input, ...(slug && { slug }) } });
  return categoryTree(true);
}

/** Blocked while the category has products or sub-categories. */
export async function deleteCategory(id: string) {
  const c = await prisma().category.findUnique({ where: { id }, select: { _count: { select: { products: true, children: true } } } });
  if (!c) throw new NotFoundError('Category not found');
  if (c._count.products || c._count.children) throw new DomainError('VALIDATION', 'Move or delete its products and sub-categories first, or deactivate it instead');
  await prisma().category.delete({ where: { id } });
  return categoryTree(true);
}

// ─── Size charts ────────────────────────────────────────────────────────────

export async function listSizeCharts() {
  const charts = await prisma().sizeChart.findMany({
    orderBy: { name: 'asc' },
    select: { id: true, name: true, dimensions: true, cells: { select: { dimension: true, valueInches: true, size: { select: { label: true, sortOrder: true } } } } },
  });
  return charts.map((c) => ({ ...c, cells: c.cells.map((x) => ({ size: x.size.label, dimension: x.dimension, valueInches: Number(x.valueInches) })) }));
}

export const listSizes = () => prisma().sizeDefinition.findMany({ orderBy: { sortOrder: 'asc' }, select: { id: true, label: true, sortOrder: true } });

/**
 * Replaces a chart's dimensions and cells. Editing a chart updates every
 * non-overridden product cell instantly; overrides are never touched. Removing a
 * dimension that has overrides is reported so the admin can clean up.
 */
export async function upsertSizeChart(id: string | null, input: { name: string; dimensions: string[]; cells: { size: string; dimension: string; valueInches: number }[] }) {
  const db = prisma();
  const sizes = await db.sizeDefinition.findMany({ select: { id: true, label: true } });
  const cells = input.cells.map((c, i) => {
    const size = sizes.find((s) => s.label === c.size);
    if (!size) throw new ValidationError({ [`cells.${i}`]: `Unknown size ${c.size}` });
    if (!input.dimensions.includes(c.dimension)) throw new ValidationError({ [`cells.${i}`]: `${c.dimension} isn’t one of the chart’s columns` });
    if (c.valueInches < 1 || c.valueInches > 99.9) throw new ValidationError({ [`cells.${i}`]: 'Use a value between 1 and 99.9 inches' });
    return { sizeId: size.id, dimension: c.dimension, valueInches: c.valueInches };
  });
  const chart = await db.$transaction(async (tx) => {
    const saved = id
      ? await tx.sizeChart.update({ where: { id }, data: { name: input.name, dimensions: input.dimensions }, select: { id: true } })
      : await tx.sizeChart.create({ data: { name: input.name, dimensions: input.dimensions }, select: { id: true } });
    await tx.sizeChartCell.deleteMany({ where: { chartId: saved.id } });
    await tx.sizeChartCell.createMany({ data: cells.map((c) => ({ ...c, chartId: saved.id })) });
    return saved;
  });
  const orphaned = await db.productSizeOverride.findMany({
    where: { dimension: { notIn: input.dimensions }, product: { category: { sizeChartId: chart.id } } },
    select: { dimension: true, product: { select: { id: true, name: true } } },
  });
  return { chartId: chart.id, orphanedOverrides: orphaned.map((o) => ({ productId: o.product.id, product: o.product.name, dimension: o.dimension })) };
}

// ─── Attribute sets ─────────────────────────────────────────────────────────

export async function listAttributeSets() {
  return prisma().attributeSet.findMany({
    orderBy: { name: 'asc' },
    select: { id: true, name: true, definitions: { orderBy: { sortOrder: 'asc' }, select: { id: true, key: true, label: true, type: true, filterable: true, required: true, options: { orderBy: { sortOrder: 'asc' }, select: { value: true, label: true, active: true } } } } },
  });
}

type DefInput = { key: string; label: string; type: 'SELECT' | 'MULTI_SELECT' | 'TEXT' | 'BOOLEAN' | 'NUMBER'; filterable?: boolean; required?: boolean; options?: { value: string; label: string; active?: boolean }[] };

/** Upserts definitions by key. Definitions not listed are kept (deleting would drop product data). */
export async function upsertAttributeSet(id: string | null, input: { name: string; definitions: DefInput[] }) {
  const db = prisma();
  await db.$transaction(async (tx) => {
    const set = id ? await tx.attributeSet.update({ where: { id }, data: { name: input.name } }) : await tx.attributeSet.create({ data: { name: input.name } });
    for (const [i, d] of input.definitions.entries()) {
      const data = { label: d.label, type: d.type, filterable: d.filterable ?? false, required: d.required ?? false, sortOrder: i };
      const def = await tx.attributeDefinition.upsert({ where: { setId_key: { setId: set.id, key: d.key } }, create: { ...data, setId: set.id, key: d.key }, update: data });
      for (const [j, o] of (d.options ?? []).entries())
        await tx.attributeValueOption.upsert({
          where: { definitionId_value: { definitionId: def.id, value: o.value } },
          create: { definitionId: def.id, value: o.value, label: o.label, sortOrder: j, active: o.active ?? true },
          update: { label: o.label, sortOrder: j, active: o.active ?? true },
        });
    }
  });
  return listAttributeSets();
}

// ─── Collections ────────────────────────────────────────────────────────────

export async function upsertCollection(id: string | null, input: { name: string; slug?: string; type: 'MANUAL' | 'AUTO_NEW' | 'AUTO_SALE'; productIds?: string[]; bannerUrls?: string[]; active?: boolean }) {
  const slug = slugify(input.slug ?? input.name);
  const data: Prisma.CollectionUncheckedCreateInput = { name: input.name, slug, type: input.type, productIds: input.productIds ?? [], bannerUrls: input.bannerUrls ?? [], active: input.active ?? true };
  return id ? prisma().collection.update({ where: { id }, data }) : prisma().collection.create({ data });
}
