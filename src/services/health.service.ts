import { prisma } from '../db.js';

/** Liveness + DB ping. */
export async function health() {
  const started = Date.now();
  try {
    await prisma().$queryRaw`SELECT 1`;
    return { status: 'ok' as const, db: 'ok' as const, dbLatencyMs: Date.now() - started, uptimeSeconds: Math.round(process.uptime()) };
  } catch {
    return { status: 'degraded' as const, db: 'down' as const, dbLatencyMs: null, uptimeSeconds: Math.round(process.uptime()) };
  }
}
