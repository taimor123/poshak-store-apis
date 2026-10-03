import { timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';
import { env } from '../../config/env.js';

declare module 'express-serve-static-core' {
  interface Request {
    /** The shopper's IP: forwarded by the trusted storefront server, else the socket/proxy IP. */
    clientIp: string;
  }
}

const sameSecret = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/**
 * Every storefront request reaches the API from the Next.js server, so without
 * this all shoppers would share one IP — and one rate-limit bucket.
 */
export const clientIpMiddleware: RequestHandler = (req, _res, next) => {
  const secret = env().INTERNAL_PROXY_SECRET;
  const given = req.get('x-poshak-proxy-secret');
  const forwarded = req.get('x-poshak-client-ip')?.trim();
  req.clientIp = secret && given && forwarded && sameSecret(given, secret) ? forwarded.slice(0, 64) : (req.ip ?? 'unknown');
  next();
};
