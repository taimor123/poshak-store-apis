"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
require("dotenv/config");
const client_1 = require("@prisma/client");
const pg_1 = require("pg");
const adapter_pg_1 = require("@prisma/adapter-pg");
const catalog_1 = require("./services/catalog");
const sizing_1 = require("./services/sizing");
const app = (0, express_1.default)();
app.use((0, cors_1.default)());
app.use(express_1.default.json());
const pool = new pg_1.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new adapter_pg_1.PrismaPg(pool);
const prisma = new client_1.PrismaClient({ adapter });
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok' });
});
app.get('/api/products/:categorySlug', async (req, res) => {
    try {
        const products = await catalog_1.CatalogService.getProductsByCategory(prisma, req.params.categorySlug);
        res.json(products);
    }
    catch (error) {
        res.status(500).json({ error: 'Internal Server Error' });
    }
});
app.get('/api/product/:slug', async (req, res) => {
    try {
        const product = await catalog_1.CatalogService.getProductBySlug(prisma, req.params.slug);
        if (!product) {
            return res.status(404).json({ error: 'Product not found' });
        }
        const sizeResolution = await sizing_1.SizingService.resolveChart(prisma, product.id);
        res.json({ product, sizeResolution });
    }
    catch (error) {
        res.status(500).json({ error: 'Internal Server Error' });
    }
});
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
    console.log(`Poshak Store API running on port ${PORT}`);
});
