import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { requireAdmin } from '../auth/authz.js';
import { success } from '../http/errors.js';
import { getConfig, updateConfig, ConfigSchema } from '../services/config.service.js';
import * as inventory from '../services/inventory.service.js';
import * as orders from '../services/order.service.js';
import * as returns from '../services/returns.service.js';
import { listZones, replaceZones } from '../services/shipping.service.js';
import * as products from '../services/admin/products.service.js';
import * as taxonomy from '../services/admin/taxonomy.service.js';
import { dashboard } from '../services/admin/dashboard.service.js';
import { categoryTree } from '../services/catalog.service.js';
import { parse } from '../validation/parse.js';
import { zPage } from '../validation/primitives.js';
import * as s from '../validation/schemas.js';

/**
 * /api/v1/admin/* — role=ADMIN. Defense in depth: the router-level guard below
 * AND a requireAdmin() call in every handler (AUTHORIZATION.md).
 */
export const adminRouter = Router();

const adminOnly: RequestHandler = (req, _res, next) => {
  requireAdmin(req);
  next();
};
adminRouter.use(adminOnly);

// ─── Dashboard ──────────────────────────────────────────────────────────────

adminRouter.get('/dashboard', async (req, res) => {
  requireAdmin(req);
  res.json(success(await dashboard()));
});

// ─── Products ───────────────────────────────────────────────────────────────

adminRouter.get('/products', async (req, res) => {
  requireAdmin(req);
  const q = zPage.extend({ status: z.enum(['DRAFT', 'PUBLISHED', 'ARCHIVED']).optional().catch(undefined), q: z.string().max(80).optional(), categoryId: z.string().max(64).optional() }).parse(req.query);
  res.json(success(await products.adminListProducts(q)));
});

adminRouter.get('/products/:id', async (req, res) => {
  requireAdmin(req);
  res.json(success(await products.adminProduct(req.params.id)));
});

adminRouter.post('/products', async (req, res) => {
  requireAdmin(req);
  res.status(201).json(success(await products.createProduct(parse(s.productSchema, req.body))));
});

adminRouter.patch('/products/:id', async (req, res) => {
  requireAdmin(req);
  res.json(success(await products.updateProduct(req.params.id, parse(s.productPatchSchema, req.body))));
});

adminRouter.post('/products/:id/duplicate', async (req, res) => {
  requireAdmin(req);
  res.status(201).json(success(await products.duplicateProduct(req.params.id)));
});

adminRouter.post('/products/:id/archive', async (req, res) => {
  requireAdmin(req);
  res.json(success(await products.archiveProduct(req.params.id)));
});

adminRouter.post('/products/:id/restore', async (req, res) => {
  requireAdmin(req);
  res.json(success(await products.restoreProduct(req.params.id)));
});

adminRouter.put('/products/:id/variants', async (req, res) => {
  requireAdmin(req);
  res.json(success(await products.setVariants(req.params.id, parse(s.variantsSchema, req.body).variants)));
});

adminRouter.put('/products/:id/size-overrides', async (req, res) => {
  requireAdmin(req);
  res.json(success(await products.setSizeOverrides(req.params.id, parse(s.sizeOverridesSchema, req.body))));
});

adminRouter.put('/products/:id/images', async (req, res) => {
  requireAdmin(req);
  res.json(success(await products.setImages(req.params.id, parse(s.imagesSchema, req.body).images)));
});

adminRouter.post('/uploads/sign', async (req, res) => {
  requireAdmin(req);
  res.json(success(products.signUpload()));
});

// ─── Inventory ──────────────────────────────────────────────────────────────

adminRouter.get('/inventory', async (req, res) => {
  requireAdmin(req);
  const q = zPage.extend({ filter: z.enum(['low', 'all']).default('all').catch('all'), q: z.string().max(80).optional() }).parse(req.query);
  res.json(success(await inventory.listInventory({ ...q, lowStockThreshold: (await getConfig()).lowStockThreshold })));
});

adminRouter.get('/inventory/:variantId/ledger', async (req, res) => {
  requireAdmin(req);
  res.json(success(await inventory.ledgerFor(req.params.variantId)));
});

/** The only stock-writing endpoint; always writes the ledger. */
adminRouter.post('/inventory/adjust', async (req, res) => {
  const admin = requireAdmin(req);
  res.json(success(await inventory.adminAdjust(parse(s.stockAdjustSchema, req.body), admin.id)));
});

// ─── Orders & returns ───────────────────────────────────────────────────────

adminRouter.get('/orders', async (req, res) => {
  requireAdmin(req);
  const q = zPage.extend({ statusTab: z.string().max(20).optional(), q: z.string().max(80).optional() }).parse(req.query);
  res.json(success(await orders.adminListOrders(q)));
});

adminRouter.get('/orders/:orderNo', async (req, res) => {
  requireAdmin(req);
  res.json(success(await orders.orderView(req.params.orderNo, { forCustomer: false })));
});

adminRouter.post('/orders/:orderNo/transition', async (req, res) => {
  const admin = requireAdmin(req);
  const { to, ...opts } = parse(s.transitionSchema, req.body);
  await orders.transition(req.params.orderNo, to, { type: 'ADMIN', id: admin.id }, opts);
  res.json(success(await orders.orderView(req.params.orderNo, { forCustomer: false })));
});

adminRouter.post('/orders/:orderNo/refund', async (req, res) => {
  const admin = requireAdmin(req);
  res.json(success(await orders.refund(req.params.orderNo, parse(s.refundSchema, req.body), admin.id)));
});

adminRouter.get('/returns', async (req, res) => {
  requireAdmin(req);
  res.json(success(await returns.listReturns(z.string().max(20).optional().catch(undefined).parse(req.query.status))));
});

adminRouter.post('/returns/:returnId/decide', async (req, res) => {
  const admin = requireAdmin(req);
  res.json(success(await returns.decideReturn(req.params.returnId, parse(s.returnDecisionSchema, req.body), admin.id)));
});

adminRouter.post('/returns/:returnId/receive', async (req, res) => {
  const admin = requireAdmin(req);
  res.json(success(await returns.receiveReturn(req.params.returnId, parse(s.returnReceiveSchema, req.body), admin.id)));
});

// ─── Taxonomy & settings ────────────────────────────────────────────────────

adminRouter.get('/categories', async (req, res) => {
  requireAdmin(req);
  res.json(success(await categoryTree(true)));
});

adminRouter.post('/categories', async (req, res) => {
  requireAdmin(req);
  res.status(201).json(success(await taxonomy.createCategory(parse(s.categorySchema, req.body))));
});

adminRouter.patch('/categories/:id', async (req, res) => {
  requireAdmin(req);
  res.json(success(await taxonomy.updateCategory(req.params.id, parse(s.categorySchema.partial(), req.body))));
});

adminRouter.delete('/categories/:id', async (req, res) => {
  requireAdmin(req);
  res.json(success(await taxonomy.deleteCategory(req.params.id)));
});

adminRouter.get('/sizes', async (req, res) => {
  requireAdmin(req);
  res.json(success(await taxonomy.listSizes()));
});

adminRouter.get('/size-charts', async (req, res) => {
  requireAdmin(req);
  res.json(success(await taxonomy.listSizeCharts()));
});

adminRouter.post('/size-charts', async (req, res) => {
  requireAdmin(req);
  res.status(201).json(success(await taxonomy.upsertSizeChart(null, parse(s.sizeChartSchema, req.body))));
});

adminRouter.put('/size-charts/:id', async (req, res) => {
  requireAdmin(req);
  res.json(success(await taxonomy.upsertSizeChart(req.params.id, parse(s.sizeChartSchema, req.body))));
});

adminRouter.get('/attribute-sets', async (req, res) => {
  requireAdmin(req);
  res.json(success(await taxonomy.listAttributeSets()));
});

adminRouter.put('/attribute-sets/:id', async (req, res) => {
  requireAdmin(req);
  res.json(success(await taxonomy.upsertAttributeSet(req.params.id, parse(s.attributeSetSchema, req.body))));
});

adminRouter.post('/collections', async (req, res) => {
  requireAdmin(req);
  res.status(201).json(success(await taxonomy.upsertCollection(null, parse(s.collectionSchema, req.body))));
});

adminRouter.put('/collections/:id', async (req, res) => {
  requireAdmin(req);
  res.json(success(await taxonomy.upsertCollection(req.params.id, parse(s.collectionSchema, req.body))));
});

adminRouter.get('/config', async (req, res) => {
  requireAdmin(req);
  res.json(success(await getConfig()));
});

adminRouter.put('/config', async (req, res) => {
  const admin = requireAdmin(req);
  res.json(success(await updateConfig(parse(ConfigSchema.partial(), req.body), admin.id)));
});

adminRouter.get('/shipping-zones', async (req, res) => {
  requireAdmin(req);
  res.json(success(await listZones(true)));
});

adminRouter.put('/shipping-zones', async (req, res) => {
  requireAdmin(req);
  res.json(success(await replaceZones(parse(s.zonesSchema, req.body).zones)));
});
