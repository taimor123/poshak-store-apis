import { randomUUID } from 'node:crypto';
import type { CookieOptions, Response } from 'express';
import { SignJWT, jwtVerify } from 'jose';
import { env } from '../config/env.js';

// The one module that owns cookie names, claims and lifetimes (AUTHENTICATION.md).

export const SESSION_COOKIE = 'psk_session';
export const ANON_COOKIE = 'psk_anon';

const CUSTOMER_TTL_S = 30 * 24 * 60 * 60; // 30 days rolling
const ADMIN_TTL_S = 8 * 60 * 60; // 8 hours absolute
const ANON_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type Role = 'CUSTOMER' | 'ADMIN';
export type SessionClaims = { sub: string; role: Role; sv: number };
export type VerifiedClaims = SessionClaims & { iat: number };

/** Customer sessions are re-issued once they're a day old, so 30 days of inactivity — not 30 days total — signs you out. */
export const shouldRoll = (c: VerifiedClaims) => c.role === 'CUSTOMER' && Date.now() / 1000 - c.iat > 24 * 60 * 60;

const key = () => new TextEncoder().encode(env().JWT_SECRET);

const baseCookie = (): CookieOptions => ({
  httpOnly: true,
  sameSite: 'lax',
  secure: env().cookieSecure,
  domain: env().COOKIE_DOMAIN,
  path: '/',
});

export async function issueSession(res: Response, claims: SessionClaims) {
  const ttl = claims.role === 'ADMIN' ? ADMIN_TTL_S : CUSTOMER_TTL_S;
  const token = await new SignJWT({ role: claims.role, sv: claims.sv })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.sub)
    .setIssuedAt()
    .setExpirationTime(`${ttl}s`)
    .sign(key());
  res.cookie(SESSION_COOKIE, token, { ...baseCookie(), maxAge: ttl * 1000 });
}

export function clearSession(res: Response) {
  res.clearCookie(SESSION_COOKIE, baseCookie());
}

export async function verifySessionToken(token: string): Promise<VerifiedClaims | null> {
  try {
    const { payload } = await jwtVerify(token, key(), { algorithms: ['HS256'] });
    if (typeof payload.sub !== 'string' || (payload.role !== 'CUSTOMER' && payload.role !== 'ADMIN') || typeof payload.sv !== 'number') return null;
    return { sub: payload.sub, role: payload.role, sv: payload.sv, iat: payload.iat ?? 0 };
  } catch {
    return null;
  }
}

/** Guest-cart identity: returns the existing anon id or issues a new cookie. */
export function ensureAnonId(existing: string | undefined, res: Response): string {
  if (existing && /^[0-9a-f-]{36}$/.test(existing)) return existing;
  const id = randomUUID();
  res.cookie(ANON_COOKIE, id, { ...baseCookie(), maxAge: ANON_TTL_MS });
  return id;
}
