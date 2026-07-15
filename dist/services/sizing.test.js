"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const client_1 = require("@prisma/client");
const pg_1 = require("pg");
const adapter_pg_1 = require("@prisma/adapter-pg");
const sizing_1 = require("./sizing");
require("dotenv/config");
(0, vitest_1.describe)('SizingService.resolveChart', () => {
    let prisma;
    (0, vitest_1.beforeAll)(() => {
        const pool = new pg_1.Pool({ connectionString: process.env.DATABASE_URL });
        const adapter = new adapter_pg_1.PrismaPg(pool);
        prisma = new client_1.PrismaClient({ adapter });
    });
    (0, vitest_1.afterAll)(async () => {
        await prisma.$disconnect();
    });
    (0, vitest_1.test)('resolves product with cell override', async () => {
        // get product 1
        const prod = await prisma.product.findUnique({ where: { slug: 'demo-product-1' } });
        (0, vitest_1.expect)(prod).not.toBeNull();
        const resolved = await sizing_1.SizingService.resolveChart(prisma, prod.id);
        (0, vitest_1.expect)(resolved).not.toBeNull();
        // Demo product 1 was seeded with S, M, L variants
        (0, vitest_1.expect)(resolved.sizes).toEqual(['S', 'M', 'L']);
        (0, vitest_1.expect)(resolved.dimensions).toContain('Chest');
        // Find the cell for M Chest (we overrode this to 38 in seed)
        const cellMChest = resolved.cells.find(c => c.size === 'M' && c.dimension === 'Chest');
        (0, vitest_1.expect)(cellMChest).toBeDefined();
        (0, vitest_1.expect)(cellMChest.isOverridden).toBe(true);
        (0, vitest_1.expect)(Number(cellMChest.valueInches)).toBe(38); // The override value
        // Find the cell for S Chest (default from category is 38)
        const cellSChest = resolved.cells.find(c => c.size === 'S' && c.dimension === 'Chest');
        (0, vitest_1.expect)(cellSChest).toBeDefined();
        (0, vitest_1.expect)(cellSChest.isOverridden).toBe(false);
        (0, vitest_1.expect)(Number(cellSChest.valueInches)).toBe(38); // The default value from category
    });
});
