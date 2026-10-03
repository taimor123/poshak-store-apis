import { prisma } from '../db.js';

/**
 * The three-level size system (docs/FASHION_DOMAIN/SIZE_SYSTEM.md):
 *   Level 1 global sizes → Level 2 category chart → Level 3 sparse product overrides.
 * Resolution per cell: productOverride[size][dimension] ?? categoryChart[size][dimension].
 * Offered sizes = sizes with a (non-archived) variant.
 */

export type ChartCell = { size: string; dimension: string; valueInches: number };
export type ResolvedChart = {
  chartName: string;
  dimensions: string[];
  rows: { size: string; values: Record<string, number | null> }[];
  fitNote: string | null;
};

/** Pure resolution — unit-tested independently of the database. */
export function resolveCells(input: {
  dimensions: string[];
  offeredSizes: string[]; // already in global sort order
  chartCells: ChartCell[];
  overrides: ChartCell[];
}): ResolvedChart['rows'] {
  const key = (s: string, d: string) => `${s}\u0000${d}`;
  const chart = new Map(input.chartCells.map((c) => [key(c.size, c.dimension), c.valueInches]));
  const over = new Map(input.overrides.map((c) => [key(c.size, c.dimension), c.valueInches]));
  return input.offeredSizes.map((size) => ({
    size,
    values: Object.fromEntries(input.dimensions.map((d) => [d, over.get(key(size, d)) ?? chart.get(key(size, d)) ?? null])),
  }));
}

/** Finds the chart bound to a category, walking up to the parent when unset. */
export async function chartIdForCategory(categoryId: string): Promise<string | null> {
  const db = prisma();
  let id: string | null = categoryId;
  for (let depth = 0; id && depth < 5; depth++) {
    const c: { sizeChartId: string | null; parentId: string | null } | null = await db.category.findUnique({ where: { id }, select: { sizeChartId: true, parentId: true } });
    if (!c) return null;
    if (c.sizeChartId) return c.sizeChartId;
    id = c.parentId;
  }
  return null;
}

export async function resolveChart(productId: string): Promise<ResolvedChart | null> {
  const db = prisma();
  const product = await db.product.findUnique({
    where: { id: productId },
    select: {
      categoryId: true,
      fitNote: true,
      category: { select: { sizeMode: true } },
      variants: { where: { archived: false, sizeId: { not: null } }, select: { size: { select: { label: true, sortOrder: true } } } },
      sizeOverrides: { select: { dimension: true, valueInches: true, size: { select: { label: true } } } },
    },
  });
  if (!product || product.category.sizeMode !== 'STITCHED') return null;
  const chartId = await chartIdForCategory(product.categoryId);
  if (!chartId) return null;
  const chart = await db.sizeChart.findUnique({
    where: { id: chartId },
    select: { name: true, dimensions: true, cells: { select: { dimension: true, valueInches: true, size: { select: { label: true } } } } },
  });
  if (!chart) return null;

  const offered = Array.from(new Map(product.variants.flatMap((v) => (v.size ? [[v.size.label, v.size.sortOrder] as const] : []))))
    .sort((a, b) => a[1] - b[1])
    .map(([label]) => label);

  return {
    chartName: chart.name,
    dimensions: chart.dimensions,
    fitNote: product.fitNote,
    rows: resolveCells({
      dimensions: chart.dimensions,
      offeredSizes: offered,
      chartCells: chart.cells.map((c) => ({ size: c.size.label, dimension: c.dimension, valueInches: Number(c.valueInches) })),
      overrides: product.sizeOverrides.map((c) => ({ size: c.size.label, dimension: c.dimension, valueInches: Number(c.valueInches) })),
    }),
  };
}
