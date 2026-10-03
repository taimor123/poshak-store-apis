import { Router } from 'express';
import { z } from 'zod';
import { optionalUser, requireUser } from '../auth/authz.js';
import { ANON_COOKIE } from '../auth/session.js';
import { ValidationError, success } from '../http/errors.js';
import { rateLimit } from '../http/middleware/rateLimit.js';
import * as orders from '../services/order.service.js';
import { requestReturn } from '../services/returns.service.js';
import { parse } from '../validation/parse.js';
import { zPage, zPakPhone } from '../validation/primitives.js';
import { cancelSchema, checkoutSchema, idempotencyKeySchema, returnSchema } from '../validation/schemas.js';

export const ordersRouter = Router();

const tokenOf = (q: unknown) => z.object({ t: z.string().max(100).optional() }).catch({}).parse(q).t;

// public: guest checkout is a right — the cart owner is the session or anon cookie
ordersRouter.post('/', rateLimit('orders-ip', 20, 60 * 60 * 1000), async (req, res) => {
  const key = idempotencyKeySchema.safeParse(req.get('Idempotency-Key'));
  if (!key.success) throw new ValidationError({ idempotencyKey: 'Send a UUID Idempotency-Key header' });
  const body = parse(checkoutSchema, req.body);
  const user = optionalUser(req);
  const anonId = req.cookies?.[ANON_COOKIE] as string | undefined;
  const owner = user ? { userId: user.id } : anonId ? { anonId } : null;
  if (!owner) throw new ValidationError({ cart: 'Your cart is empty' });
  const placed = await orders.place({ ...body, idempotencyKey: key.data }, owner, user);
  res.status(placed.replay ? 200 : 201).json(success(placed));
});

// public: order number + mobile (rate-limited; mismatches are indistinguishable 404s)
ordersRouter.post('/track', rateLimit('track', 10, 15 * 60 * 1000), async (req, res) => {
  const body = parse(z.object({ orderNo: z.string().trim().toUpperCase().max(30), phone: zPakPhone }), req.body);
  res.set('Cache-Control', 'no-store').json(success(await orders.trackByPhone(body.orderNo, body.phone)));
});

/** Own orders, newest first. */
ordersRouter.get('/', async (req, res) => {
  const user = requireUser(req);
  const page = zPage.parse(req.query);
  res.json(success(await orders.listMyOrders(user.id, page.cursor, page.limit)));
});

/** Owner, admin, or guest token (?t=). Anything else → 404. */
ordersRouter.get('/:orderNo', async (req, res) => {
  await orders.requireOrderAccess(req.params.orderNo, optionalUser(req), tokenOf(req.query));
  res.set('Cache-Control', 'no-store').json(success(await orders.orderView(req.params.orderNo, { forCustomer: req.user?.role !== 'ADMIN' })));
});

ordersRouter.post('/:orderNo/cancel', async (req, res) => {
  await orders.requireOrderAccess(req.params.orderNo, optionalUser(req), tokenOf(req.query));
  const { reason } = parse(cancelSchema, req.body);
  res.json(success(await orders.cancelByCustomer(req.params.orderNo, reason, { type: 'CUSTOMER', id: req.user?.id })));
});

ordersRouter.post('/:orderNo/return', async (req, res) => {
  await orders.requireOrderAccess(req.params.orderNo, optionalUser(req), tokenOf(req.query));
  const body = parse(returnSchema, req.body);
  res.status(201).json(success(await requestReturn(req.params.orderNo, body, { type: 'CUSTOMER', id: req.user?.id })));
});
