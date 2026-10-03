import { beforeEach, describe, expect, it } from 'vitest';
import { sentEmails } from '../../src/services/notification.service.js';
import { ADMIN, adminAgent, agent, customerAgent, db, placeOrder, resetDb, variantId } from '../helpers.js';

beforeEach(resetDb);

describe('accounts (AUTHENTICATION.md)', () => {
  it('register → session → logout', async () => {
    const a = agent();
    const reg = await a.post('/api/v1/auth/register').send({ email: 'Sana@Test.pk', password: 'a-good-long-password', name: 'Sana Ali' });
    expect(reg.status).toBe(201);
    expect(String(reg.headers['set-cookie'])).toMatch(/psk_session=.*HttpOnly/i);
    expect(reg.body.data.user).toMatchObject({ email: 'sana@test.pk', role: 'CUSTOMER' });

    expect((await a.get('/api/v1/auth/session')).body.data.user.email).toBe('sana@test.pk');
    await a.post('/api/v1/auth/logout').expect(200);
    expect((await a.get('/api/v1/auth/session')).body.data.user).toBeNull();
  });

  it('stores only an argon2id hash', async () => {
    const { email } = await customerAgent();
    const u = await db().user.findUniqueOrThrow({ where: { email } });
    expect(u.passwordHash).toMatch(/^\$argon2id\$/);
  });

  it('rejects duplicate emails and weak passwords', async () => {
    await agent().post('/api/v1/auth/register').send({ email: 'x@test.pk', password: 'a-good-long-password', name: 'X Y' }).expect(201);
    const dup = await agent().post('/api/v1/auth/register').send({ email: 'x@test.pk', password: 'a-good-long-password', name: 'X Y' });
    expect(dup.status).toBe(422);
    const weak = await agent().post('/api/v1/auth/register').send({ email: 'y@test.pk', password: 'password123', name: 'Y Z' });
    expect(weak.body.error.fieldErrors.password).toMatch(/common/);
  });

  it('login failures are generic — no user-existence oracle', async () => {
    const { email } = await customerAgent();
    const wrongPw = await agent().post('/api/v1/auth/login').send({ email, password: 'not-the-password' });
    const noUser = await agent().post('/api/v1/auth/login').send({ email: 'nobody@test.pk', password: 'not-the-password' });
    expect(wrongPw.status).toBe(401);
    expect(noUser.status).toBe(401);
    expect(wrongPw.body.error.message).toBe(noUser.body.error.message);
  });

  it('locks the account after 5 failures, even with the right password', async () => {
    const { email } = await customerAgent();
    for (let i = 0; i < 5; i++) await agent().post('/api/v1/auth/login').send({ email, password: 'wrong-password' }).expect(401);
    const locked = await agent().post('/api/v1/auth/login').send({ email, password: 'a-good-long-password' });
    expect(locked.status).toBe(429);
  });

  it('password reset: uniform response, single-use token, old sessions revoked', async () => {
    const { agent: oldSession, email } = await customerAgent();
    const unknown = await agent().post('/api/v1/auth/forgot-password').send({ email: 'nobody@test.pk' });
    const known = await agent().post('/api/v1/auth/forgot-password').send({ email });
    expect(unknown.body).toEqual(known.body);

    const mail = sentEmails().find((m) => m.to === email && /Reset/.test(m.subject))!;
    const token = /token=([\w-]+)/.exec(mail.text)![1];
    await agent().post('/api/v1/auth/reset-password').send({ token, password: 'brand-new-secret-phrase' }).expect(200);
    await agent().post('/api/v1/auth/reset-password').send({ token, password: 'another-new-phrase' }).expect(422); // single use

    expect((await oldSession.get('/api/v1/auth/session')).body.data.user).toBeNull(); // revoked
    await agent().post('/api/v1/auth/login').send({ email, password: 'brand-new-secret-phrase' }).expect(200);
  });

  it('log out everywhere invalidates every existing session', async () => {
    const { agent: a, email } = await customerAgent();
    const other = agent();
    await other.post('/api/v1/auth/login').send({ email, password: 'a-good-long-password' }).expect(200);
    await a.post('/api/v1/auth/logout-all').expect(200);
    expect((await other.get('/api/v1/auth/session')).body.data.user).toBeNull();
  });

  it('a tampered session cookie is treated as signed out', async () => {
    const res = await agent().get('/api/v1/auth/session').set('Cookie', 'psk_session=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4Iiwicm9sZSI6IkFETUlOIiwic3YiOjB9.forged');
    expect(res.body.data.user).toBeNull();
  });
});

describe('authorization boundary (AUTHORIZATION.md)', () => {
  it('anonymous → admin API is 401; customer → admin API is 403', async () => {
    await agent().get('/api/v1/admin/dashboard').expect(401);
    const { agent: c } = await customerAgent();
    for (const [method, path] of [
      ['get', '/api/v1/admin/dashboard'],
      ['get', '/api/v1/admin/orders'],
      ['post', '/api/v1/admin/inventory/adjust'],
      ['post', '/api/v1/admin/products'],
      ['put', '/api/v1/admin/config'],
    ] as const) {
      const res = await c[method](path).send({});
      expect(res.status, `${method} ${path}`).toBe(403);
    }
  });

  it('admin can reach admin routes', async () => {
    const a = await adminAgent();
    const res = await a.get('/api/v1/admin/dashboard').expect(200);
    expect(res.body.data.actionCounts).toBeDefined();
  });

  it('a demoted admin loses access on the very next request (sessionVersion/role re-check)', async () => {
    const a = await adminAgent();
    await db().user.update({ where: { email: ADMIN.email }, data: { role: 'CUSTOMER' } });
    await a.get('/api/v1/admin/dashboard').expect(401);
  });

  it('customers see only their own orders; other people get 404', async () => {
    const alice = await customerAgent();
    const bob = await customerAgent();
    const placed = await placeOrder(alice.agent, [{ sku: 'PSK-DEMO-02-M', qty: 1 }], { email: alice.email });
    const { orderNo, guestToken } = placed.body.data;
    expect(guestToken).toBeNull(); // signed-in orders don't need one

    await alice.agent.get(`/api/v1/orders/${orderNo}`).expect(200);
    await bob.agent.get(`/api/v1/orders/${orderNo}`).expect(404);
    expect((await alice.agent.get('/api/v1/orders')).body.data.items.map((o: { orderNo: string }) => o.orderNo)).toEqual([orderNo]);
    expect((await bob.agent.get('/api/v1/orders')).body.data.items).toEqual([]);
    await agent().get('/api/v1/orders').expect(401);
  });

  it('addresses are scoped to their owner', async () => {
    const alice = await customerAgent();
    const bob = await customerAgent();
    const created = await alice.agent
      .post('/api/v1/account/addresses')
      .send({ name: 'Alice Home', phone: '0300 1112223', line1: 'House 1, Street 2, DHA Phase 5', city: 'lahore' })
      .expect(201);
    expect(created.body.data).toMatchObject({ city: 'Lahore', isDefault: true });
    await bob.agent.delete(`/api/v1/account/addresses/${created.body.data.id}`).expect(404);
    await alice.agent.delete(`/api/v1/account/addresses/${created.body.data.id}`).expect(200);
  });
});

describe('cart merge on login (CART_FLOW.md §Merge)', () => {
  it('guest cart lines move into the account cart; guest quantity wins', async () => {
    const { email } = await customerAgent();
    const a = agent();
    await a.post('/api/v1/cart/lines').send({ variantId: await variantId('PSK-DEMO-02-M'), qty: 2 }).expect(200);
    await a.post('/api/v1/auth/login').send({ email, password: 'a-good-long-password' }).expect(200);
    const cart = (await a.get('/api/v1/cart')).body.data;
    expect(cart.lines).toHaveLength(1);
    expect(cart.lines[0].qty).toBe(2);
    expect(await db().cart.count({ where: { anonId: { not: null } } })).toBe(0);
  });
});
