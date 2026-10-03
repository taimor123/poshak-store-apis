import { beforeAll, describe, expect, it } from 'vitest';
import { agent, db, resetDb, setStock, variantId } from '../helpers.js';

beforeAll(resetDb);

describe('catalog reads', () => {
  it('health pings the database', async () => {
    const res = await agent().get('/health').expect(200);
    expect(res.body.data).toMatchObject({ status: 'ok', db: 'ok' });
  });

  it('category tree hides inactive categories (Bridal)', async () => {
    const tree = (await agent().get('/api/v1/categories').expect(200)).body.data;
    expect(tree.map((c: { slug: string }) => c.slug)).toEqual(['unstitched', 'ready-to-wear', 'formals']);
  });

  it('category pages aggregate descendants and expose facets', async () => {
    const res = (await agent().get('/api/v1/categories/ready-to-wear/products').expect(200)).body.data;
    expect(res.total).toBe(6);
    expect(res.breadcrumbs).toEqual([{ slug: 'ready-to-wear', name: 'Ready to Wear' }]);
    expect(res.facets.hasStitched).toBe(true);
    const sub = (await agent().get('/api/v1/categories/ready-to-wear/rtw-kurtis/products').query({ fabric: 'Khaddar' }).expect(200)).body.data;
    expect(sub.items.map((i: { slug: string }) => i.slug)).toEqual(['sitara']);
    expect(sub.breadcrumbs.map((b: { slug: string }) => b.slug)).toEqual(['ready-to-wear', 'rtw-kurtis']);
  });

  it('forgiving reads: junk filter values are ignored, unknown categories 404', async () => {
    await agent().get('/api/v1/categories/formals/products').query({ price: 'banana', sort: 'weird', limit: 'x' }).expect(200);
    await agent().get('/api/v1/categories/nope/products').expect(404);
  });

  it('collections: sale and new', async () => {
    const sale = (await agent().get('/api/v1/collections/sale').expect(200)).body.data;
    expect(sale.items.map((i: { slug: string }) => i.slug).sort()).toEqual(['roshan', 'sitara']);
    expect(sale.items.every((i: { badge: string }) => i.badge === 'SALE')).toBe(true);
    const fresh = (await agent().get('/api/v1/collections/new').expect(200)).body.data;
    expect(fresh.items.map((i: { slug: string }) => i.slug)).toContain('gulnar');
  });

  it('PDP: unstitched has no size chart, only pack contents', async () => {
    const p = (await agent().get('/api/v1/products/gulnar').expect(200)).body.data;
    expect(p.mode).toBe('UNSTITCHED');
    expect(p.sizeChart).toBeNull();
    expect(p.variants).toHaveLength(1);
    expect(p.fabricContents.map((f: { lengthYards: number }) => f.lengthYards)).toEqual([1.25, 1.75, 2.5, 2.5]);
  });

  it('honest stock: low only when genuinely ≤ threshold', async () => {
    const dilnaz = (await agent().get('/api/v1/products/dilnaz').expect(200)).body.data;
    expect(dilnaz.stock).toEqual({ total: 2, low: true });
    const sana = (await agent().get('/api/v1/products/sana').expect(200)).body.data;
    expect(sana.stock.low).toBe(false);
  });

  it('search matches names, fabrics and categories', async () => {
    const lawn = (await agent().get('/api/v1/search').query({ q: 'lawn' }).expect(200)).body.data;
    expect(lawn.items.length).toBeGreaterThanOrEqual(5);
    const kurti = (await agent().get('/api/v1/search').query({ q: 'kurtis' }).expect(200)).body.data;
    expect(kurti.items.map((i: { slug: string }) => i.slug)).toEqual(expect.arrayContaining(['noor', 'sitara']));
    expect((await agent().get('/api/v1/search').query({ q: 'zzzz' }).expect(200)).body.data.total).toBe(0);
  });

  it('shipping quote applies the free-shipping threshold', async () => {
    const below = (await agent().get('/api/v1/shipping-quote').query({ city: 'lahore', subtotalPaisa: 100000 }).expect(200)).body.data;
    expect(below).toMatchObject({ city: 'Lahore', feePaisa: 25000, expressAvailable: true });
    const above = (await agent().get('/api/v1/shipping-quote').query({ city: 'Lahore', subtotalPaisa: 600000 }).expect(200)).body.data;
    expect(above.feePaisa).toBe(0);
    await agent().get('/api/v1/shipping-quote').query({ city: 'Atlantis' }).expect(422);
  });
});

describe('cart (CART_FLOW.md)', () => {
  it('guest cart via anon cookie: add, increment, clamp to stock and cap', async () => {
    const a = agent();
    const id = await variantId('PSK-DEMO-08-S'); // stock 1
    const first = await a.post('/api/v1/cart/lines').send({ variantId: id, qty: 3 }).expect(200);
    expect(String(first.headers['set-cookie'])).toMatch(/psk_anon=/);
    expect(first.body.data.clamped).toBe(true);
    expect(first.body.data.cart.lines[0].qty).toBe(1);
    expect(first.body.data.cart.subtotalPaisa).toBe(1890000);
  });

  it('flags sold-out and unpublished lines, and blocks checkout until resolved', async () => {
    const a = agent();
    await a.post('/api/v1/cart/lines').send({ variantId: await variantId('PSK-DEMO-04-M'), qty: 1 }).expect(200);
    await a.post('/api/v1/cart/lines').send({ variantId: await variantId('PSK-DEMO-16-M'), qty: 1 }).expect(200);
    await setStock('PSK-DEMO-04-M', 0);
    await db().product.update({ where: { slug: 'bano' }, data: { status: 'ARCHIVED' } });
    const cart = (await a.get('/api/v1/cart').expect(200)).body.data;
    expect(cart.lines.map((l: { status: string }) => l.status).sort()).toEqual(['out_of_stock', 'removed']);
    expect(cart.canCheckout).toBe(false);
    expect(cart.subtotalPaisa).toBe(0);
    await db().product.update({ where: { slug: 'bano' }, data: { status: 'PUBLISHED' } });
  });

  it('current price always wins, with a notice', async () => {
    const a = agent();
    await a.post('/api/v1/cart/lines').send({ variantId: await variantId('PSK-DEMO-09'), qty: 1 }).expect(200);
    await db().product.update({ where: { slug: 'mehr' }, data: { pricePaisa: 360000 } });
    const cart = (await a.get('/api/v1/cart')).body.data;
    expect(cart.lines[0]).toMatchObject({ unitPricePaisa: 360000, notices: ['price_up'] });
    expect((await a.get('/api/v1/cart')).body.data.lines[0].notices).toEqual([]); // shown once
  });

  it('qty 0 removes; other people’s lines are 404', async () => {
    const a = agent();
    const add = await a.post('/api/v1/cart/lines').send({ variantId: await variantId('PSK-DEMO-13-M'), qty: 2 });
    const lineId = add.body.data.cart.lines[0].id;
    await agent().patch(`/api/v1/cart/lines/${lineId}`).send({ qty: 1 }).expect(404);
    const after = await a.patch(`/api/v1/cart/lines/${lineId}`).send({ qty: 0 }).expect(200);
    expect(after.body.data.lines).toHaveLength(0);
  });

  it('archived or unknown variants are VARIANT_GONE', async () => {
    const res = await agent().post('/api/v1/cart/lines').send({ variantId: 'does-not-exist', qty: 1 });
    expect(res.status).toBe(410);
    expect(res.body.error.code).toBe('VARIANT_GONE');
  });
});
