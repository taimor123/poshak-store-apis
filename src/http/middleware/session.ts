import type { RequestHandler } from 'express';
import { SESSION_COOKIE, clearSession, verifySessionToken } from '../../auth/session.js';
import { resolveSessionUser } from '../../services/auth.service.js';

/**
 * Verifies the session JWT and re-checks it against the DB (role + sessionVersion),
 * closing the JWT revocation gap on every request. Invalid → anonymous.
 */
export const sessionMiddleware: RequestHandler = async (req, res, next) => {
  const token = req.cookies?.[SESSION_COOKIE] as string | undefined;
  if (!token) return next();
  const claims = await verifySessionToken(token);
  const user = claims ? await resolveSessionUser(claims) : null;
  if (user) req.user = user;
  else clearSession(res);
  next();
};
