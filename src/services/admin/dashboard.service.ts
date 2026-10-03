import { prisma } from '../../db.js';
import { getConfig } from '../config.service.js';

/** GET /admin/dashboard: action counts, revenue, recent orders. */
export async function dashboard() {
  const db = prisma();
  const cfg = await getConfig();
  const day = 86_400_000;
  const now = Date.now();
  const startOfToday = new Date(new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Karachi' }) + 'T00:00:00+05:00');
  const revenueSince = async (since: Date) =>
    (await db.order.aggregate({ where: { placedAt: { gte: since }, status: { notIn: ['CANCELLED', 'PENDING_PAYMENT'] } }, _sum: { totalPaisa: true } }))._sum.totalPaisa ?? 0;

  const [toConfirm, toShip, lowStock, today, d7, d30, recent] = await Promise.all([
    db.order.count({ where: { status: 'PENDING' } }),
    db.order.count({ where: { status: { in: ['CONFIRMED', 'PACKED'] } } }),
    db.productVariant.count({ where: { archived: false, stock: { lte: cfg.lowStockThreshold }, product: { status: 'PUBLISHED' } } }),
    revenueSince(startOfToday),
    revenueSince(new Date(now - 7 * day)),
    revenueSince(new Date(now - 30 * day)),
    db.order.findMany({ orderBy: { placedAt: 'desc' }, take: 8, select: { orderNo: true, status: true, shipName: true, totalPaisa: true, placedAt: true } }),
  ]);
  return {
    actionCounts: { toConfirm, toShip, lowStock },
    revenue: { today, d7, d30 },
    recentOrders: recent.map((o) => ({ orderNo: o.orderNo, status: o.status, customer: o.shipName, totalPaisa: o.totalPaisa, placedAt: o.placedAt.toISOString() })),
  };
}
