import express from 'express';
import cors from 'cors';
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { CatalogService } from './services/catalog';
import { SizingService } from './services/sizing';

const app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.get('/api/products/:categorySlug', async (req, res) => {
  try {
    const products = await CatalogService.getProductsByCategory(prisma, req.params.categorySlug);
    res.json(products);
  } catch (error) {
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.get('/api/product/:slug', async (req, res) => {
  try {
    const product = await CatalogService.getProductBySlug(prisma, req.params.slug);
    if (!product) {
      return res.status(404).json({ error: 'Product not found' });
    }
    const sizeResolution = await SizingService.resolveChart(prisma, product.id);
    res.json({ product, sizeResolution });
  } catch (error) {
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Poshak Store API running on port ${PORT}`);
});
