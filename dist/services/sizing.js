"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SizingService = void 0;
class SizingService {
    /**
     * Resolves the size chart for a product.
     * Fetches the category's bound size chart, the product's offered variants to know which sizes to show,
     * and the product's specific size overrides.
     * Implements: productOverride[size][dimension] ?? categoryChart[size][dimension]
     */
    static async resolveChart(prisma, productId) {
        const product = await prisma.product.findUnique({
            where: { id: productId },
            include: {
                category: {
                    include: {
                        sizeChart: {
                            include: {
                                cells: {
                                    include: { size: true }
                                }
                            }
                        }
                    }
                },
                variants: {
                    where: { stock: { gt: 0 } }, // Or just existence? Spec says "offered sizes ⊆ chart sizes. variants exist only for offered sizes."
                    include: { size: true }
                },
                sizeOverrides: {
                    include: { size: true }
                }
            }
        });
        if (!product || !product.category.sizeChart) {
            return null;
        }
        const chart = product.category.sizeChart;
        // Determine offered sizes: sizes that have at least one variant
        // We sort sizes based on the global SizeDefinition sortOrder
        const offeredSizesMap = new Map();
        product.variants.forEach(v => {
            if (v.sizeId && v.size) {
                offeredSizesMap.set(v.sizeId, { label: v.size.label, sortOrder: v.size.sortOrder });
            }
        });
        // Default chart cells map: [sizeId][dimension] -> valueInches
        const defaultCells = new Map();
        chart.cells.forEach(cell => {
            if (!defaultCells.has(cell.sizeId)) {
                defaultCells.set(cell.sizeId, new Map());
            }
            defaultCells.get(cell.sizeId).set(cell.dimension, Number(cell.valueInches));
        });
        // Product overrides map: [sizeId][dimension] -> valueInches
        const overrides = new Map();
        product.sizeOverrides.forEach(over => {
            if (!overrides.has(over.sizeId)) {
                overrides.set(over.sizeId, new Map());
            }
            overrides.get(over.sizeId).set(over.dimension, Number(over.valueInches));
        });
        const resolvedCells = [];
        // Sort the offered sizes
        const sortedSizeIds = Array.from(offeredSizesMap.keys()).sort((a, b) => offeredSizesMap.get(a).sortOrder - offeredSizesMap.get(b).sortOrder);
        // Only resolve for offered sizes
        for (const sizeId of sortedSizeIds) {
            const sizeLabel = offeredSizesMap.get(sizeId).label;
            for (const dimension of chart.dimensions) {
                const overrideValue = overrides.get(sizeId)?.get(dimension);
                const defaultValue = defaultCells.get(sizeId)?.get(dimension);
                if (overrideValue !== undefined) {
                    resolvedCells.push({
                        size: sizeLabel,
                        dimension,
                        valueInches: overrideValue,
                        isOverridden: true
                    });
                }
                else if (defaultValue !== undefined) {
                    resolvedCells.push({
                        size: sizeLabel,
                        dimension,
                        valueInches: defaultValue,
                        isOverridden: false
                    });
                }
            }
        }
        return {
            productId,
            chartId: chart.id,
            dimensions: chart.dimensions,
            sizes: sortedSizeIds.map(id => offeredSizesMap.get(id).label),
            cells: resolvedCells
        };
    }
}
exports.SizingService = SizingService;
