import type { Request } from 'express';
import { ForbiddenError, UnauthorizedError } from '../http/errors.js';

// The only authorization vocabulary controllers use (AUTHORIZATION.md).
// Every controller calls exactly one require* (or is marked `// public:`).

export type SessionUser = { id: string; role: 'CUSTOMER' | 'ADMIN'; name: string; email: string };

declare module 'express-serve-static-core' {
  interface Request {
    /** Set by the session middleware after the JWT and sessionVersion check. */
    user?: SessionUser;
  }
}

export function requireUser(req: Request): SessionUser {
  if (!req.user) throw new UnauthorizedError();
  return req.user;
}

export function requireAdmin(req: Request): SessionUser {
  const user = requireUser(req);
  if (user.role !== 'ADMIN') throw new ForbiddenError();
  return user;
}

/** Optional session (public routes that behave differently when signed in). */
export const optionalUser = (req: Request): SessionUser | null => req.user ?? null;
