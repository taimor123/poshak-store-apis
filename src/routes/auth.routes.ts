import { Router, type Request, type Response } from 'express';
import { requireUser } from '../auth/authz.js';
import { ANON_COOKIE, clearSession, issueSession } from '../auth/session.js';
import { success } from '../http/errors.js';
import { rateLimit } from '../http/middleware/rateLimit.js';
import * as auth from '../services/auth.service.js';
import { mergeGuestCart } from '../services/cart.service.js';
import { parse } from '../validation/parse.js';
import { changePasswordSchema, forgotSchema, loginSchema, registerSchema, resetSchema } from '../validation/schemas.js';

export const authRouter = Router();

const FIFTEEN_MIN = 15 * 60 * 1000;
const authLimit = rateLimit('auth', 10, FIFTEEN_MIN);

/** After sign-in: merge the guest cart into the account cart (CART_FLOW.md §Merge). */
async function afterSignIn(req: Request, res: Response, userId: string) {
  const anonId = req.cookies?.[ANON_COOKIE] as string | undefined;
  const merge = anonId ? await mergeGuestCart(anonId, userId) : { changes: [] };
  if (anonId) res.clearCookie(ANON_COOKIE, { path: '/' });
  return merge.changes;
}

// public: registration
authRouter.post('/register', authLimit, async (req, res) => {
  const body = parse(registerSchema, req.body);
  const { user, sessionVersion } = await auth.register(body);
  await issueSession(res, { sub: user.id, role: user.role, sv: sessionVersion });
  const cartChanges = await afterSignIn(req, res, user.id);
  res.status(201).json(success({ user, cartChanges }));
});

// public: login
authRouter.post('/login', authLimit, async (req, res) => {
  const body = parse(loginSchema, req.body);
  const { user, sessionVersion } = await auth.login(body);
  await issueSession(res, { sub: user.id, role: user.role, sv: sessionVersion });
  const cartChanges = await afterSignIn(req, res, user.id);
  res.json(success({ user, cartChanges }));
});

// public: logout is always allowed
authRouter.post('/logout', (_req, res) => {
  clearSession(res);
  res.json(success({ signedOut: true }));
});

/** Ends every session on every device. */
authRouter.post('/logout-all', async (req, res) => {
  const user = requireUser(req);
  await auth.bumpSessionVersion(user.id);
  clearSession(res);
  res.json(success({ signedOut: true }));
});

// public: the frontend's session source (null when signed out)
authRouter.get('/session', (req, res) => {
  res.json(success({ user: req.user ?? null }));
});

authRouter.post('/change-password', authLimit, async (req, res) => {
  const user = requireUser(req);
  const body = parse(changePasswordSchema, req.body);
  const result = await auth.changePassword(user.id, body);
  await issueSession(res, { sub: result.user.id, role: result.user.role, sv: result.sessionVersion });
  res.json(success({ user: result.user }));
});

// public: uniform response whether or not the email exists
authRouter.post('/forgot-password', authLimit, async (req, res) => {
  const { email } = parse(forgotSchema, req.body);
  await auth.forgotPassword(email);
  res.json(success({ message: 'If an account exists for that email, we’ve sent a link to reset the password.' }));
});

// public: token-gated
authRouter.post('/reset-password', authLimit, async (req, res) => {
  const body = parse(resetSchema, req.body);
  await auth.resetPassword(body);
  clearSession(res);
  res.json(success({ message: 'Your password has been reset. Please sign in.' }));
});
