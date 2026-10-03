import { beforeEach, describe, expect, it } from 'vitest';
import { runDailyJob } from '../../src/jobs/scheduler.js';
import { auditLedger } from '../../src/services/inventory.service.js';
import { adminAgent, agent, db, placeOrder, resetDb, variantId } from '../helpers.js';

beforeEach(resetDb);

const stockOf = async (sku: string) => (await db().productVariant.findUniqueOrThrow({ where: { sku } })).stock;

async function newOrder(sku = 'PSK-DEMO-02-M', qty = 1) {
  const res = await placeOrder(agent(), [{ sku, qty }]);
  expect(res.status).toBe(201);
  return res.body.data as { orderNo: string; guestToken: string };
}

describe('order lifecycle (ORDER_LIFECYCLE.md)', () => {
  it('walks PENDING → CONFIRMED → PACKED → SHIPPED → DELIVERED with events, emails and COD collection', async () => {
    const admin = await adminAgent();
    const { orderNo } = await newOrder();
    const go = (to: string, extra: object = {}) => admin.post(`/api/v1/admin/orders/${orderNo}/transition`).send({ to, ...extra });

    await go('CONFIRMED').expect(200);
    await go('PACKED').expect(200);
    const noTracking = await go('SHIPPED');
    expect(noTracking.status).toBe(422);
    await go('SHIPPED', { courier: 'TCS', trackingNo: '7739 2041 5521' }).expect(200);
    const delivered = await go('DELIVERED').expect(200);

    expect(delivered.body.data.status).toBe('DELIVERED');
    expect(delivered.body.data.payment.status).toBe('COLLECTED');
    expect(delivered.body.data.timeline.map((t: { status: string }) => t.status)).toEqual(['PENDING', 'CONFIRMED', 'PACKED', 'SHIPPED', 'DELIVERED']);
    expect(delivered.body.data.timeline[1].actor).toBe('ADMIN');
  });

  it('rejects transitions outside the table — even for admins', async () => {
    const admin = await adminAgent();
    const { orderNo } = await newOrder();
    const res = await admin.post(`/api/v1/admin/orders/${orderNo}/transition`).send({ to: 'SHIPPED', courier: 'TCS', trackingNo: '1' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ILLEGAL_TRANSITION');
    const completed = await admin.post(`/api/v1/admin/orders/${orderNo}/transition`).send({ to: 'COMPLETED' });
    expect(completed.status).toBe(409); // COMPLETED is SYSTEM-only
  });

  it('customers can cancel only before packing', async () => {
    const admin = await adminAgent();
    const { orderNo, guestToken } = await newOrder();
    await admin.post(`/api/v1/admin/orders/${orderNo}/transition`).send({ to: 'CONFIRMED' }).expect(200);
    await admin.post(`/api/v1/admin/orders/${orderNo}/transition`).send({ to: 'PACKED' }).expect(200);
    const res = await agent().post(`/api/v1/orders/${orderNo}/cancel`).query({ t: guestToken }).send({ reason: 'changed my mind' });
    expect(res.status).toBe(409);
  });

  it('admin cancel after packing restocks; the ledger still balances', async () => {
    const admin = await adminAgent();
    const before = await stockOf('PSK-DEMO-11-L');
    const { orderNo } = await newOrder('PSK-DEMO-11-L', 2);
    expect(await stockOf('PSK-DEMO-11-L')).toBe(before - 2);
    await admin.post(`/api/v1/admin/orders/${orderNo}/transition`).send({ to: 'CONFIRMED' }).expect(200);
    await admin.post(`/api/v1/admin/orders/${orderNo}/transition`).send({ to: 'PACKED' }).expect(200);
    await admin.post(`/api/v1/admin/orders/${orderNo}/transition`).send({ to: 'CANCELLED' }).expect(422); // reason required
    await admin.post(`/api/v1/admin/orders/${orderNo}/transition`).send({ to: 'CANCELLED', reason: 'customer unreachable' }).expect(200);
    expect(await stockOf('PSK-DEMO-11-L')).toBe(before);
    expect(await auditLedger()).toEqual([]);
  });

  it('daily job completes delivered orders after the return window', async () => {
    const admin = await adminAgent();
    const { orderNo } = await newOrder();
    for (const to of ['CONFIRMED', 'PACKED']) await admin.post(`/api/v1/admin/orders/${orderNo}/transition`).send({ to }).expect(200);
    await admin.post(`/api/v1/admin/orders/${orderNo}/transition`).send({ to: 'SHIPPED', courier: 'Leopards', trackingNo: 'LP1' }).expect(200);
    await admin.post(`/api/v1/admin/orders/${orderNo}/transition`).send({ to: 'DELIVERED' }).expect(200);
    await db().order.update({ where: { orderNo }, data: { deliveredAt: new Date(Date.now() - 8 * 86_400_000) } });
    await runDailyJob();
    expect((await db().order.findUniqueOrThrow({ where: { orderNo } })).status).toBe('COMPLETED');
  });
});

describe('returns (ORDER_LIFECYCLE.md §Returns policy)', () => {
  it('request → approve → receive restocks sellable items and computes the refund', async () => {
    const admin = await adminAgent();
    const { orderNo, guestToken } = await newOrder('PSK-DEMO-02-M', 2);
    for (const to of ['CONFIRMED', 'PACKED']) await admin.post(`/api/v1/admin/orders/${orderNo}/transition`).send({ to }).expect(200);
    await admin.post(`/api/v1/admin/orders/${orderNo}/transition`).send({ to: 'SHIPPED', courier: 'TCS', trackingNo: 'T1' }).expect(200);
    await admin.post(`/api/v1/admin/orders/${orderNo}/transition`).send({ to: 'DELIVERED' }).expect(200);

    const item = (await db().orderItem.findFirstOrThrow({ where: { order: { orderNo } } })).id;
    const noPhoto = await agent().post(`/api/v1/orders/${orderNo}/return`).query({ t: guestToken }).send({ items: [{ orderItemId: item, qty: 1 }], reason: 'damaged' });
    expect(noPhoto.status).toBe(422);
    const req = await agent().post(`/api/v1/orders/${orderNo}/return`).query({ t: guestToken }).send({ items: [{ orderItemId: item, qty: 1 }], reason: 'wrong-size' });
    expect(req.status).toBe(201);

    const before = await stockOf('PSK-DEMO-02-M');
    await admin.post(`/api/v1/admin/returns/${req.body.data.returnId}/decide`).send({ approve: true, note: 'Approved, pickup booked' }).expect(200);
    const ret = await db().returnItem.findFirstOrThrow({ where: { returnRequestId: req.body.data.returnId } });
    const received = await admin.post(`/api/v1/admin/returns/${req.body.data.returnId}/receive`).send({ items: [{ id: ret.id, qcOutcome: 'SELLABLE' }] });
    expect(received.status).toBe(200);
    expect(received.body.data.refundDuePaisa).toBe(395000);
    expect(await stockOf('PSK-DEMO-02-M')).toBe(before + 1);
    expect((await db().order.findUniqueOrThrow({ where: { orderNo } })).status).toBe('RETURNED');

    const refund = await admin.post(`/api/v1/admin/orders/${orderNo}/refund`).send({ amountPaisa: 395000, method: 'jazzcash', reason: 'Size return' });
    expect(refund.status).toBe(200);
    expect(refund.body.data.payment.status).toBe('PARTIALLY_REFUNDED');
    const over = await admin.post(`/api/v1/admin/orders/${orderNo}/refund`).send({ amountPaisa: 99999999, method: 'jazzcash', reason: 'x too much' });
    expect(over.status).toBe(422);
    expect(await auditLedger()).toEqual([]);
  });
});

describe('inventory (INVENTORY_FLOW.md)', () => {
  it('adjusts through the ledger and refuses to go below zero', async () => {
    const admin = await adminAgent();
    const id = await variantId('PSK-DEMO-08-XS'); // stock 0
    await admin.post('/api/v1/admin/inventory/adjust').send({ variantId: id, delta: 5, reason: 'received-stock' }).expect(200);
    const neg = await admin.post('/api/v1/admin/inventory/adjust').send({ variantId: id, delta: -6, reason: 'recount' });
    expect(neg.status).toBe(422);
    const other = await admin.post('/api/v1/admin/inventory/adjust').send({ variantId: id, delta: -1, reason: 'other' });
    expect(other.body.error.fieldErrors.note).toBeDefined();
    expect(await stockOf('PSK-DEMO-08-XS')).toBe(5);
    const ledger = (await admin.get(`/api/v1/admin/inventory/${id}/ledger`)).body.data;
    expect(ledger[0]).toMatchObject({ delta: 5, source: 'ADMIN', balanceAfter: 5 });
    const low = (await admin.get('/api/v1/admin/inventory').query({ filter: 'low' })).body.data.items;
    expect(low.every((r: { stock: number }) => r.stock <= 3)).toBe(true);
  });

  it('the database itself refuses negative stock', async () => {
    const id = await variantId('PSK-DEMO-08-XS');
    await expect(db().productVariant.update({ where: { id }, data: { stock: -1 } })).rejects.toThrow();
  });
});

describe('admin products (PRODUCT_ATTRIBUTE_SYSTEM.md §Validation)', () => {
  it('create draft → publish gates → variants/images → published on the storefront', async () => {
    const admin = await adminAgent();
    const kurtis = await db().category.findUniqueOrThrow({ where: { slug: 'rtw-kurtis' } });
    const created = await admin.post('/api/v1/admin/products').send({
      categoryId: kurtis.id,
      name: 'Zoya — Lawn Kurti, Coral',
      description: 'A breezy coral lawn kurti with a pintucked yoke and side slits, cut straight.',
      pricePaisa: 420000,
      attributes: { fabric: 'Lawn', colour: 'Coral' },
    });
    expect(created.status).toBe(201);
    const id = created.body.data.id;
    expect(created.body.data.status).toBe('DRAFT');
    await agent().get(`/api/v1/products/${created.body.data.slug}`).expect(404); // drafts aren't public

    const early = await admin.patch(`/api/v1/admin/products/${id}`).send({ status: 'PUBLISHED' });
    expect(early.status).toBe(422);
    expect(Object.keys(early.body.error.fieldErrors)).toEqual(expect.arrayContaining(['images', 'variants']));

    const vs = await admin.put(`/api/v1/admin/products/${id}/variants`).send({ variants: [{ size: 'S' }, { size: 'M' }, { size: 'L' }] });
    expect(vs.body.data.allVariants.map((v: { sku: string }) => v.sku)).toEqual(expect.arrayContaining([expect.stringMatching(/^PSK-P\d{4}-M$/)]));
    await admin
      .put(`/api/v1/admin/products/${id}/images`)
      .send({ images: [1, 2, 3].map((i) => ({ url: `https://res.example/zoya-${i}.jpg`, altText: `Zoya kurti view ${i}`, isCover: i === 1 })) })
      .expect(200);
    await admin.put(`/api/v1/admin/products/${id}/size-overrides`).send({ overrides: [{ size: 'M', dimension: 'chest', valueInches: 39 }], fitNote: 'Relaxed fit' }).expect(200);
    const bad = await admin.put(`/api/v1/admin/products/${id}/size-overrides`).send({ overrides: [{ size: 'M', dimension: 'flare', valueInches: 39 }] });
    expect(bad.status).toBe(422);

    await admin.patch(`/api/v1/admin/products/${id}`).send({ status: 'PUBLISHED' }).expect(200);
    const pdp = (await agent().get(`/api/v1/products/${created.body.data.slug}`).expect(200)).body.data;
    expect(pdp.sizeChart.rows.find((r: { size: string }) => r.size === 'M').values.chest).toBe(39);
    expect(pdp.sizeChart.rows.map((r: { size: string }) => r.size)).toEqual(['S', 'M', 'L']);
    expect(pdp.fitNote).toBe('Relaxed fit');
  });

  it('removing an ordered variant archives it instead of deleting history', async () => {
    const admin = await adminAgent();
    await newOrder('PSK-DEMO-02-XS', 1);
    const noor = await db().product.findUniqueOrThrow({ where: { slug: 'noor' } });
    await admin.put(`/api/v1/admin/products/${noor.id}/variants`).send({ variants: ['S', 'M', 'L', 'XL'].map((size) => ({ size })) }).expect(200);
    expect((await db().productVariant.findUniqueOrThrow({ where: { sku: 'PSK-DEMO-02-XS' } })).archived).toBe(true);
  });

  it('category guardrails: no delete with products, max 3 levels', async () => {
    const admin = await adminAgent();
    const kurtis = await db().category.findUniqueOrThrow({ where: { slug: 'rtw-kurtis' } });
    expect((await admin.delete(`/api/v1/admin/categories/${kurtis.id}`)).status).toBe(422);
    const trousers = await db().category.findUniqueOrThrow({ where: { slug: 'rtw-trousers' } }); // level 3
    const tooDeep = await admin.post('/api/v1/admin/categories').send({ name: 'Too deep', parentId: trousers.id, sizeMode: 'STITCHED' });
    expect(tooDeep.status).toBe(422);
  });

  it('config changes are validated and take effect', async () => {
    const admin = await adminAgent();
    await admin.put('/api/v1/admin/config').send({ returnWindowDays: 1 }).expect(422);
    await admin.put('/api/v1/admin/config').send({ freeShippingThresholdPaisa: 10_000_00 }).expect(200);
    expect((await agent().get('/api/v1/config/public')).body.data.freeShippingThresholdPaisa).toBe(10_000_00);
  });
});
