"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CatalogService = void 0;
const client_1 = require("@prisma/client");
class CatalogService {
    /**
     * Fetches published products for a specific category slug.
     */
    static async getProductsByCategory(prisma, slug) {
        return prisma.product.findMany({
            where: {
                category: { slug },
                status: client_1.ProductStatus.PUBLISHED,
            },
            include: {
                images: {
                    orderBy: { sortOrder: 'asc' }
                },
                variants: {
                    where: { stock: { gt: 0 } }
                },
            },
            orderBy: { createdAt: 'desc' }
        });
    }
    /**
     * Fetches a specific product by slug.
     */
    static async getProductBySlug(prisma, slug) {
        return prisma.product.findUnique({
            where: { slug, status: client_1.ProductStatus.PUBLISHED },
            include: {
                images: { orderBy: { sortOrder: 'asc' } },
                variants: {
                    include: { size: true }
                },
                category: true,
                fabricContents: true,
                attributeValues: {
                    include: { definition: true }
                }
            }
        });
    }
}
exports.CatalogService = CatalogService;
