import type { Request, RequestHandler } from 'express';
import { RateLimitedError } from '../errors.js';

/**
 * Sliding-window limiter, in memory (single instance). BACKEND_ARCHITECTURE.md
 * targets Upstash Redis for multi-instance deployments — swap the store, keep the API.
 */
const hits = new Map<string, number[]>();

export function hit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  recent.push(now);
  hits.set(key, recent);
  return recent.length <= limit;
}

export function resetRateLimits() {
  hits.clear();
}

export const rateLimit = (name: string, limit: number, windowMs: number, keyOf: (req: Request) => string = (req) => req.clientIp ?? req.ip ?? 'unknown'): RequestHandler =>
  (req, _res, next) => {
    if (!hit(`${name}:${keyOf(req)}`, limit, windowMs)) return next(new RateLimitedError());
    next();
  };

// Periodically drop stale keys so the map doesn't grow without bound.
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of hits) if (!v.some((t) => now - t < 60 * 60 * 1000)) hits.delete(k);
}, 10 * 60 * 1000).unref();
