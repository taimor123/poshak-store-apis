import { beforeEach, describe, expect, it } from 'vitest';
import { agent, resetDb } from '../helpers.js';

// Regression tests for bugs found in review (2026-10-03).

beforeEach(resetDb);

const SECRET = 'test-proxy-secret-0123456789abcdef0123456789';

describe('search never 500s on odd input', () => {
  it.each(['a-', 'zz-zz-', "';--", '-lawn-', 'lawn & | ! :*', '(((', '3-piece'])('%s', async (q) => {
    const res = await agent().get('/api/v1/search').query({ q });
    expect(res.status).toBe(200);
  });

  it('hyphenated words still match', async () => {
    const res = await agent().get('/api/v1/search').query({ q: '3-piece-' }).expect(200);
    expect(res.body.data.total).toBeGreaterThan(0);
  });
});

describe('rate limits are per shopper, not per storefront server', () => {
  const forgot = (ip?: string, secret?: string) => {
    const r = agent().post('/api/v1/auth/forgot-password');
    if (ip) r.set('x-poshak-client-ip', ip);
    if (secret) r.set('x-poshak-proxy-secret', secret);
    return r.send({ email: 'x@test.pk' });
  };

  it('trusted forwarded IPs get separate buckets', async () => {
    for (let i = 0; i < 10; i++) await forgot('10.0.0.1', SECRET).expect(200);
    await forgot('10.0.0.1', SECRET).expect(429);
    await forgot('10.0.0.2', SECRET).expect(200); // a different shopper is unaffected
  });

  it('a forged client-ip header without the secret is ignored', async () => {
    for (let i = 0; i < 10; i++) await forgot(`10.9.9.${i}`, 'wrong-secret-wrong-secret-wrong-secret').expect(200);
    await forgot('10.9.9.99').expect(429); // all counted against the real socket IP
  });
});

describe('category intros', () => {
  it('sub-categories inherit the parent’s intro', async () => {
    const res = await agent().get('/api/v1/categories/ready-to-wear/rtw-kurtis/products').expect(200);
    expect(res.body.data.category.description).toMatch(/real garment measurements/);
  });
});
