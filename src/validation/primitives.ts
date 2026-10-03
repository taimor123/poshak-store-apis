import { z } from 'zod';

// Shared primitives — implements docs/BACKEND/VALIDATION_RULES.md §Shared primitives.
// The app mirrors these in its own src/lib/validation; this repo's copy is the law.

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const clean = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .refine((s) => !CONTROL.test(s), 'Remove special control characters');

/** PK mobile → normalized "+923XXXXXXXXX". */
export const zPakPhone = z
  .string()
  .transform((s) => s.replace(/[\s-]/g, ''))
  .refine((s) => /^(\+92|0)3[0-9]{9}$/.test(s), 'Enter a valid Pakistani mobile number, like 0300 1234567')
  .transform((s) => (s.startsWith('0') ? `+92${s.slice(1)}` : s));

export const zEmail = z.string().trim().toLowerCase().max(254).email('Enter a valid email address');

export const zPaisa = z.number().int().min(0).max(100_000_000_000);

/** Admin money entry in rupees (≤ 2dp) → paisa. */
export const zRupeeInput = z
  .number()
  .positive()
  .refine((n) => Math.round(n * 100) === n * 100, 'At most 2 decimal places')
  .transform((n) => Math.round(n * 100))
  .pipe(zPaisa);

export const zSlug = z.string().max(80).regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'Use lowercase letters, numbers and dashes');
export const zName = clean(80).pipe(z.string().min(2, 'Enter at least 2 characters'));
export const zQty = z.number().int().min(1).max(10);
export const zNote = clean(200);
export const zText = (max: number) => clean(max);
export const zId = z.string().min(1).max(64);

/** Password policy (AUTH_SECURITY.md): 8–72 chars, plus a common-password blocklist in the service. */
export const zPassword = z.string().min(8, 'Use at least 8 characters').max(72, 'Use at most 72 characters');

/** Cursor pagination params. */
export const zPage = z.object({
  cursor: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(60).default(24),
});
