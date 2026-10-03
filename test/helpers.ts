import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import { prisma } from '../src/db.js';
import { resetRateLimits } from '../src/http/middleware/rateLimit.js';
import { invalidateConfig } from '../src/services/config.service.js';
import { clearSentEmails } from '../src/services/notification.service.js';
import { seed } from '../prisma/seed.js';

export const ADMIN = { email: 'admin@test.pk', password: 'correct-horse-battery' };

export const app = createApp(env());
export const db = () => prisma();

/** Wipes every table and re-seeds (taxonomy, zones, config, admin, 16 demo products). */
export async function resetDb() {
  const tables = await db().$queryRaw<{ tablename: string }[]>`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  await db().$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(', ')} RESTART IDENTITY CASCADE`);
  await seed(db(), { adminEmail: ADMIN.email, adminPassword: ADMIN.password });
  invalidateConfig();
  resetRateLimits();
  clearSentEmails();
}

export const agent = () => request.agent(app);

export async function adminAgent() {
  const a = agent();
  await a.post('/api/v1/auth/login').send(ADMIN).expect(200);
  return a;
}

export async function customerAgent(email = `c-${randomUUID().slice(0, 8)}@test.pk`) {
  const a = agent();
  await a.post('/api/v1/auth/register').send({ email, password: 'a-good-long-password', name: 'Test Customer' }).expect(201);
  return { agent: a, email };
}

/** Variant id by SKU (e.g. PSK-DEMO-02-M). */
export async function variantId(sku: string) {
  return (await db().productVariant.findUniqueOrThrow({ where: { sku }, select: { id: true } })).id;
}

export async function setStock(sku: string, stock: number) {
  const v = await db().productVariant.findUniqueOrThrow({ where: { sku } });
  const delta = stock - v.stock;
  if (delta) {
    await db().productVariant.update({ where: { id: v.id }, data: { stock } });
    await db().inventoryLedger.create({ data: { variantId: v.id, delta, reason: 'test setup', source: 'SYSTEM', balanceAfter: stock } });
  }
}

let phoneSeq = 1000000;
/** A unique valid mobile per order (the 5-orders/phone/hour limit). */
export const nextPhone = () => `0300${phoneSeq++}`;

export function checkoutBody(totalPaisa: number, overrides: Partial<{ city: string; phone: string; email: string; deliveryMethod: string }> = {}) {
  const phone = overrides.phone ?? nextPhone();
  return {
    contact: { email: overrides.email ?? 'buyer@test.pk', phone },
    address: { name: 'Ayesha Khan', line1: 'House 14, Street 6, Block 2, PECHS', city: overrides.city ?? 'Karachi' },
    paymentMethod: 'COD',
    deliveryMethod: overrides.deliveryMethod ?? 'STANDARD',
    clientTotalPaisa: totalPaisa,
  };
}

/** Adds a line, reads the cart total + shipping quote, places the order. */
export async function placeOrder(a: ReturnType<typeof agent>, lines: { sku: string; qty: number }[], opts: { key?: string; city?: string; email?: string } = {}) {
  for (const l of lines) await a.post('/api/v1/cart/lines').send({ variantId: await variantId(l.sku), qty: l.qty }).expect(200);
  const cart = (await a.get('/api/v1/cart')).body.data;
  const quote = (await a.get('/api/v1/shipping-quote').query({ city: opts.city ?? 'Karachi', subtotalPaisa: cart.subtotalPaisa })).body.data;
  return a
    .post('/api/v1/orders')
    .set('Idempotency-Key', opts.key ?? randomUUID())
    .send(checkoutBody(cart.subtotalPaisa + quote.feePaisa, { city: opts.city, email: opts.email }));
}
