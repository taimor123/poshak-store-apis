import { prisma } from '../db.js';
import { ValidationError } from '../http/errors.js';
import { getConfig } from './config.service.js';

// Shipping fee resolution (CHECKOUT_FLOW.md §Shipping fee resolution):
// city → ShippingZone → fee; free when subtotal ≥ freeShippingThreshold.
// Express is a flat fee, only where the zone allows it.

export type DeliveryMethod = 'STANDARD' | 'EXPRESS';

export async function listZones(includeInactive = false) {
  return prisma().shippingZone.findMany({
    where: includeInactive ? {} : { active: true },
    orderBy: [{ sortOrder: 'asc' }, { city: 'asc' }],
    select: { id: true, city: true, zone: true, feePaisa: true, estimateText: true, expressAvailable: true, active: true },
  });
}

export async function findZone(city: string) {
  const zone = await prisma().shippingZone.findFirst({ where: { city: { equals: city, mode: 'insensitive' }, active: true } });
  if (!zone) throw new ValidationError({ city: 'Choose a city from the list' });
  return zone;
}

export async function quote(city: string, subtotalPaisa: number, method: DeliveryMethod = 'STANDARD') {
  const [zone, cfg] = await Promise.all([findZone(city), getConfig()]);
  if (method === 'EXPRESS' && !zone.expressAvailable) throw new ValidationError({ method: `Express delivery isn’t available in ${zone.city}` });
  const free = subtotalPaisa >= cfg.freeShippingThresholdPaisa;
  const feePaisa = method === 'EXPRESS' ? cfg.expressFeePaisa : free ? 0 : zone.feePaisa;
  return {
    city: zone.city,
    method,
    feePaisa,
    estimateText: method === 'EXPRESS' ? '1–2 working days' : zone.estimateText,
    expressAvailable: zone.expressAvailable,
    freeOverPaisa: cfg.freeShippingThresholdPaisa,
  };
}

/** Admin: replace the zone table (upsert by city; cities left out are deactivated, never deleted). */
export async function replaceZones(zones: { city: string; zone: string; feePaisa: number; estimateText: string; expressAvailable: boolean; active: boolean }[]) {
  const db = prisma();
  await db.$transaction(async (tx) => {
    for (const [i, z] of zones.entries())
      await tx.shippingZone.upsert({ where: { city: z.city }, create: { ...z, sortOrder: i }, update: { ...z, sortOrder: i } });
    await tx.shippingZone.updateMany({ where: { city: { notIn: zones.map((z) => z.city) } }, data: { active: false } });
  });
  return listZones(true);
}
