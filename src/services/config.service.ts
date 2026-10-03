import { z } from 'zod';
import { prisma } from '../db.js';
import { ValidationError } from '../http/errors.js';
import { fieldErrorsOf } from '../validation/parse.js';
import { zPaisa } from '../validation/primitives.js';

/**
 * StoreConfig: admin-editable business numbers (BACKEND_ARCHITECTURE.md §Configuration).
 * Read through `getConfig()` (60 s in-memory cache) — never hard-code these.
 */
export const ConfigSchema = z.object({
  freeShippingThresholdPaisa: zPaisa,
  expressFeePaisa: zPaisa,
  lowStockThreshold: z.number().int().min(0).max(100),
  maxQtyPerLine: z.number().int().min(1).max(10),
  returnWindowDays: z.number().int().min(3).max(30),
  newArrivalDays: z.number().int().min(1).max(90),
  codEnabled: z.boolean(),
});
export type StoreConfig = z.infer<typeof ConfigSchema>;

export const CONFIG_DEFAULTS: StoreConfig = {
  freeShippingThresholdPaisa: 5_000_00,
  expressFeePaisa: 450_00,
  lowStockThreshold: 3,
  maxQtyPerLine: 10,
  returnWindowDays: 7,
  newArrivalDays: 14,
  codEnabled: true,
};

const TTL_MS = 60_000;
let cache: { at: number; value: StoreConfig } | undefined;

export async function getConfig(): Promise<StoreConfig> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.value;
  const rows = await prisma().storeConfig.findMany();
  const merged: Record<string, unknown> = { ...CONFIG_DEFAULTS };
  for (const r of rows) if (r.key in CONFIG_DEFAULTS) merged[r.key] = r.value;
  const parsed = ConfigSchema.safeParse(merged);
  const value = parsed.success ? parsed.data : CONFIG_DEFAULTS;
  cache = { at: Date.now(), value };
  return value;
}

export function invalidateConfig() {
  cache = undefined;
}

/** Partial update; every key is validated like any other input. */
export async function updateConfig(patch: Partial<StoreConfig>, _actorId: string): Promise<StoreConfig> {
  const next = ConfigSchema.safeParse({ ...(await getConfig()), ...patch });
  if (!next.success) throw new ValidationError(fieldErrorsOf(next.error));
  const db = prisma();
  await db.$transaction(
    Object.entries(patch).map(([key, value]) =>
      db.storeConfig.upsert({ where: { key }, create: { key, value: value as never }, update: { value: value as never } }),
    ),
  );
  invalidateConfig();
  return getConfig();
}

/** The subset the storefront displays. */
export async function publicConfig() {
  const c = await getConfig();
  return {
    freeShippingThresholdPaisa: c.freeShippingThresholdPaisa,
    expressFeePaisa: c.expressFeePaisa,
    lowStockThreshold: c.lowStockThreshold,
    maxQtyPerLine: c.maxQtyPerLine,
    returnWindowDays: c.returnWindowDays,
    paymentMethods: c.codEnabled ? ['COD'] : [],
  };
}
