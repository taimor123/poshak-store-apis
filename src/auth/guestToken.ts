import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../config/env.js';

/**
 * Guest order capability: HMAC(orderNo) with its own secret. Grants read +
 * status-legal cancel for that single order only. Not a session.
 */
export const guestTokenFor = (orderNo: string) => createHmac('sha256', env().GUEST_TOKEN_SECRET).update(orderNo).digest('base64url');

export function isValidGuestToken(orderNo: string, token: string | undefined): boolean {
  if (!token) return false;
  const expected = Buffer.from(guestTokenFor(orderNo));
  const given = Buffer.from(token);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
