import { Router, type Request, type Response } from 'express';
import { ANON_COOKIE, ensureAnonId } from '../auth/session.js';
import { success } from '../http/errors.js';
import * as cart from '../services/cart.service.js';
import { parse } from '../validation/parse.js';
import { addLineSchema, setQtySchema } from '../validation/schemas.js';

// Cart: the signed-in user's cart, or the guest cart keyed by the anon cookie.
// Ownership is the session / cookie itself — every handler is `// public:` by design.

export const cartRouter = Router();

/** Cart owner for writes (issues an anon cookie for new guests). */
function writeOwner(req: Request, res: Response): cart.CartOwner {
  if (req.user) return { userId: req.user.id };
  return { anonId: ensureAnonId(req.cookies?.[ANON_COOKIE], res) };
}

/** Cart owner for reads (never issues a cookie). */
function readOwner(req: Request): cart.CartOwner | null {
  if (req.user) return { userId: req.user.id };
  const anonId = req.cookies?.[ANON_COOKIE] as string | undefined;
  return anonId ? { anonId } : null;
}

const EMPTY = { id: null, lines: [], count: 0, subtotalPaisa: 0, canCheckout: false };

// public: own cart (full revalidation)
cartRouter.get('/', async (req, res) => {
  const owner = readOwner(req);
  res.set('Cache-Control', 'no-store').json(success(owner ? await cart.getCart(owner) : { ...EMPTY, maxQtyPerLine: 10 }));
});

// public: add to own cart
cartRouter.post('/lines', async (req, res) => {
  const body = parse(addLineSchema, req.body);
  const result = await cart.addLine(writeOwner(req, res), body.variantId, body.qty);
  res.json(success(result));
});

// public: change qty on own cart (0 removes)
cartRouter.patch('/lines/:lineId', async (req, res) => {
  const { qty } = parse(setQtySchema, req.body);
  res.json(success(await cart.setLineQty(writeOwner(req, res), req.params.lineId, qty)));
});

// public: remove from own cart
cartRouter.delete('/lines/:lineId', async (req, res) => {
  res.json(success(await cart.removeLine(writeOwner(req, res), req.params.lineId)));
});
