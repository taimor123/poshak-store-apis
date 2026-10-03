import cron from 'node-cron';
import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { auditLedger } from '../services/inventory.service.js';
import { completeDeliveredOrders } from '../services/order.service.js';
import { getConfig } from '../services/config.service.js';

/**
 * In-process scheduled jobs (BACKEND_ARCHITECTURE.md §Scheduled jobs). Each job
 * takes a Postgres advisory lock so a second API instance never runs it twice,
 * and logs a summary.
 */

const DAILY_LOCK = 72_001;

async function withLock(lockId: number, name: string, fn: () => Promise<unknown>) {
  const rows = await prisma().$queryRaw<{ locked: boolean }[]>`SELECT pg_try_advisory_lock(${lockId}) AS locked`;
  if (!rows[0]?.locked) return logger.info({ job: name }, 'job skipped: another instance holds the lock');
  try {
    const result = await fn();
    logger.info({ job: name, result }, 'job finished');
  } catch (err) {
    logger.error({ err, job: name }, 'job failed');
  } finally {
    await prisma().$queryRaw`SELECT pg_advisory_unlock(${lockId})`;
  }
}

/** Daily 02:00 PKT: complete delivered orders, ledger audit, low-stock digest. */
export async function runDailyJob() {
  await withLock(DAILY_LOCK, 'daily', async () => {
    const completed = await completeDeliveredOrders();
    const mismatches = await auditLedger();
    if (mismatches.length) logger.error({ mismatches }, 'INVENTORY LEDGER MISMATCH — investigate, never auto-heal');
    const { lowStockThreshold } = await getConfig();
    const low = await prisma().productVariant.count({ where: { archived: false, stock: { lte: lowStockThreshold }, product: { status: 'PUBLISHED' } } });
    return { completed, ledgerMismatches: mismatches.length, lowStockVariants: low };
  });
}

export function startScheduler() {
  const task = cron.schedule('0 2 * * *', () => void runDailyJob(), { timezone: 'Asia/Karachi' });
  logger.info('scheduler started (daily 02:00 PKT)');
  return task;
}
