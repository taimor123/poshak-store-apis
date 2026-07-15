import { PrismaClient, ProductStatus } from '@prisma/client'

export class CatalogService {
  /**
   * Fetches published products for a specific category slug.
   */
  static async getProductsByCategory(prisma: PrismaClient, slug: string) {
    return prisma.product.findMany({
      where: {
        category: { slug },
        status: ProductStatus.PUBLISHED,
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
  static async getProductBySlug(prisma: PrismaClient, slug: string) {
    return prisma.product.findUnique({
      where: { slug, status: ProductStatus.PUBLISHED },
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
