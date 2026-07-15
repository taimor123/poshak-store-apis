import { expect, test, describe, beforeAll, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { Pool } from 'pg'
import { PrismaPg } from '@prisma/adapter-pg'
import { SizingService } from './sizing'
import 'dotenv/config'

describe('SizingService.resolveChart', () => {
  let prisma: PrismaClient;

  beforeAll(() => {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL })
    const adapter = new PrismaPg(pool)
    prisma = new PrismaClient({ adapter })
  });

  afterAll(async () => {
    await prisma.$disconnect()
  });

  test('resolves product with cell override', async () => {
    // get product 1
    const prod = await prisma.product.findUnique({ where: { slug: 'demo-product-1' } })
    expect(prod).not.toBeNull()

    const resolved = await SizingService.resolveChart(prisma, prod!.id)
    
    expect(resolved).not.toBeNull()
    
    // Demo product 1 was seeded with S, M, L variants
    expect(resolved!.sizes).toEqual(['S', 'M', 'L'])
    expect(resolved!.dimensions).toContain('Chest')

    // Find the cell for M Chest (we overrode this to 38 in seed)
    const cellMChest = resolved!.cells.find(c => c.size === 'M' && c.dimension === 'Chest')
    expect(cellMChest).toBeDefined()
    expect(cellMChest!.isOverridden).toBe(true)
    expect(Number(cellMChest!.valueInches)).toBe(38) // The override value

    // Find the cell for S Chest (default from category is 38)
    const cellSChest = resolved!.cells.find(c => c.size === 'S' && c.dimension === 'Chest')
    expect(cellSChest).toBeDefined()
    expect(cellSChest!.isOverridden).toBe(false)
    expect(Number(cellSChest!.valueInches)).toBe(38) // The default value from category
  })
})
