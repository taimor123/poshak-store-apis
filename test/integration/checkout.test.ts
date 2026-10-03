import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { auditLedger } from '../../src/services/inventory.service.js';
import { sentEmails } from '../../src/services/notification.service.js';
import { agent, checkoutBody, db, placeOrder, resetDb, setStock, variantId } from '../helpers.js';

beforeEach(resetDb);

const stockOf = async (sku: string) => (await db().productVariant.findUniqueOrThrow({ where: { sku } })).stock;

describe('COD order placement (CHECKOUT_FLOW.md §Place Order)', () => {
  it('guest places an order: stock decremented, ledger + event + payment written, cart cleared', async () => {
    const a = agent();
    const before = await stockOf('PSK-DEMO-02-M');
    const res = await placeOrder(a, [{ sku: 'PSK-DEMO-02-M', qty: 2 }]);
    expect(res.status).toBe(201);
    const { orderNo, guestToken, totalPaisa } = res.body.data;
    expect(orderNo).toMatch(/^PSK-\d{6}-\d{4}$/);
    expect(guestToken).toBeTruthy();
    // 2 × 3,950 = 7,900 ≥ 5,000 → free standard shipping
    expect(totalPaisa).toBe(790000);

    expect(await stockOf('PSK-DEMO-02-M')).toBe(before - 2);
    const order = await db().order.findUniqueOrThrow({ where: { orderNo }, include: { items: true, events: true, payments: true } });
    expect(order.status).toBe('PENDING');
    expect(order.items[0]).toMatchObject({ sku: 'PSK-DEMO-02-M', qty: 2, unitPricePaisa: 395000, sizeLabel: 'M' });
    expect(order.events).toHaveLength(1);
    expect(order.payments[0]).toMatchObject({ method: 'COD', status: 'PENDING', amountPaisa: 790000 });
    expect(order.contactPhone).toMatch(/^\+923\d{9}$/); // normalized

    expect((await a.get('/api/v1/cart')).body.data.lines).toHaveLength(0);
    expect(await auditLedger()).toEqual([]);
    expect(sentEmails().some((e) => e.subject === `Order ${orderNo} placed`)).toBe(true);
  });

  it('charges shipping below the free threshold, and order numbers are sequential', async () => {
    const r1 = await placeOrder(agent(), [{ sku: 'PSK-DEMO-13-M', qty: 1 }]);
    const r2 = await placeOrder(agent(), [{ sku: 'PSK-DEMO-13-S', qty: 1 }]);
    expect(r1.body.data.totalPaisa).toBe(245000 + 25000);
    const n1 = Number(r1.body.data.orderNo.slice(-4));
    expect(Number(r2.body.data.orderNo.slice(-4))).toBe(n1 + 1);
  });

  it('rejects a stale client total with PRICE_MISMATCH and changes nothing', async () => {
    const a = agent();
    await a.post('/api/v1/cart/lines').send({ variantId: await variantId('PSK-DEMO-02-M'), qty: 1 });
    const before = await stockOf('PSK-DEMO-02-M');
    const res = await a.post('/api/v1/orders').set('Idempotency-Key', randomUUID()).send(checkoutBody(100));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PRICE_MISMATCH');
    expect(res.body.error.details.totalPaisa).toBe(395000 + 25000);
    expect(await stockOf('PSK-DEMO-02-M')).toBe(before);
    expect(await db().order.count()).toBe(0);
  });

  it('validates checkout fields with field errors', async () => {
    const a = agent();
    await a.post('/api/v1/cart/lines').send({ variantId: await variantId('PSK-DEMO-02-M'), qty: 1 });
    const res = await a
      .post('/api/v1/orders')
      .set('Idempotency-Key', randomUUID())
      .send({ ...checkoutBody(0), contact: { email: 'nope', phone: '12345' }, address: { name: 'A', line1: 'short', city: '' } });
    expect(res.status).toBe(422);
    expect(Object.keys(res.body.error.fieldErrors)).toEqual(expect.arrayContaining(['contact.email', 'contact.phone', 'address.name', 'address.line1']));
  });

  it('requires an Idempotency-Key', async () => {
    const res = await agent().post('/api/v1/orders').send(checkoutBody(0));
    expect(res.status).toBe(422);
  });

  it('express is offered only where the zone allows it', async () => {
    const a = agent();
    await a.post('/api/v1/cart/lines').send({ variantId: await variantId('PSK-DEMO-02-M'), qty: 1 });
    const res = await a.post('/api/v1/orders').set('Idempotency-Key', randomUUID()).send(checkoutBody(395000 + 45000, { city: 'Multan', deliveryMethod: 'EXPRESS' }));
    expect(res.status).toBe(422);
    expect(res.body.error.fieldErrors.method).toMatch(/Express/);
  });
});

describe('release-gating concurrency tests (PRD §8)', () => {
  it('NEVER oversells: 8 shoppers race for the last 3 units', async () => {
    await setStock('PSK-DEMO-12-M', 3);
    const shoppers = Array.from({ length: 8 }, () => agent());
    // Everyone carts one unit while stock is still 3 (the cart is not a reservation)…
    for (const s of shoppers) await s.post('/api/v1/cart/lines').send({ variantId: await variantId('PSK-DEMO-12-M'), qty: 1 }).expect(200);
    const total = 2450000; // 24,500 → free shipping
    // …then all place orders at the same moment.
    const results = await Promise.all(shoppers.map((s) => s.post('/api/v1/orders').set('Idempotency-Key', randomUUID()).send(checkoutBody(total))));

    const ok = results.filter((r) => r.status === 201);
    const conflicts = results.filter((r) => r.status === 409);
    expect(ok).toHaveLength(3);
    expect(conflicts).toHaveLength(5);
    for (const c of conflicts) expect(c.body.error.code).toBe('STOCK_CONFLICT');
    expect(await stockOf('PSK-DEMO-12-M')).toBe(0);
    expect(await db().order.count()).toBe(3);
    expect(await auditLedger()).toEqual([]);
  });

  it('NEVER double-orders: the same Idempotency-Key submitted 5× at once makes one order', async () => {
    const a = agent();
    await a.post('/api/v1/cart/lines').send({ variantId: await variantId('PSK-DEMO-02-M'), qty: 1 });
    const before = await stockOf('PSK-DEMO-02-M');
    const key = randomUUID();
    const body = checkoutBody(395000 + 25000);
    const results = await Promise.all(Array.from({ length: 5 }, () => a.post('/api/v1/orders').set('Idempotency-Key', key).send(body)));

    expect(results.every((r) => r.status === 201 || r.status === 200)).toBe(true);
    expect(new Set(results.map((r) => r.body.data.orderNo)).size).toBe(1);
    expect(await db().order.count()).toBe(1);
    expect(await stockOf('PSK-DEMO-02-M')).toBe(before - 1);
  });

  it('a later retry with the same key replays the original order', async () => {
    const a = agent();
    const key = randomUUID();
    const first = await placeOrder(a, [{ sku: 'PSK-DEMO-02-M', qty: 1 }], { key });
    const again = await a.post('/api/v1/orders').set('Idempotency-Key', key).send(checkoutBody(first.body.data.totalPaisa));
    expect(again.status).toBe(200);
    expect(again.body.data).toMatchObject({ orderNo: first.body.data.orderNo, replay: true });
  });
});

describe('guest order access (AUTHORIZATION.md §Guest token)', () => {
  it('order number + the same mobile tracks an order; anything else is 404', async () => {
    const a = agent();
    for (const l of [{ sku: 'PSK-DEMO-02-M', qty: 1 }]) await a.post('/api/v1/cart/lines').send({ variantId: await variantId(l.sku), qty: l.qty });
    const res = await a.post('/api/v1/orders').set('Idempotency-Key', randomUUID()).send(checkoutBody(420000, { phone: '0333 7654321' })).expect(201);
    const { orderNo } = res.body.data;
    const ok = await agent().post('/api/v1/orders/track').send({ orderNo: orderNo.toLowerCase(), phone: '+923337654321' }).expect(200);
    expect(ok.body.data).toMatchObject({ orderNo, status: 'PENDING' });
    expect(ok.body.data.guestToken).toBeTruthy();
    await agent().post('/api/v1/orders/track').send({ orderNo, phone: '0300 0000000' }).expect(404);
  });

  it('token holder can read and cancel; anyone else gets 404', async () => {
    const res = await placeOrder(agent(), [{ sku: 'PSK-DEMO-02-M', qty: 1 }]);
    const { orderNo, guestToken } = res.body.data;
    const stranger = agent();

    await stranger.get(`/api/v1/orders/${orderNo}`).expect(404);
    await stranger.get(`/api/v1/orders/${orderNo}`).query({ t: 'forged-token' }).expect(404);
    const view = await stranger.get(`/api/v1/orders/${orderNo}`).query({ t: guestToken }).expect(200);
    expect(view.body.data).toMatchObject({ orderNo, status: 'PENDING', canCancel: true });
    expect(view.body.data.timeline[0].actor).toBeUndefined(); // customers don't see audit detail

    const before = await stockOf('PSK-DEMO-02-M');
    const cancel = await stranger.post(`/api/v1/orders/${orderNo}/cancel`).query({ t: guestToken }).send({ reason: 'ordered wrong size' });
    expect(cancel.status).toBe(200);
    expect(cancel.body.data.status).toBe('CANCELLED');
    expect(await stockOf('PSK-DEMO-02-M')).toBe(before + 1); // restocked
    expect(await auditLedger()).toEqual([]);
  });
});
