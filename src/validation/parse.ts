import type { ZodError, ZodType } from 'zod';
import { ValidationError } from '../http/errors.js';

/** zod issues → fieldErrors keyed by path (first message per field). */
export function fieldErrorsOf(err: ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const i of err.issues) {
    const k = i.path.join('.') || '_';
    out[k] ??= i.message;
  }
  return out;
}

/** Strict parse for writes: invalid input → VALIDATION with field errors. Returns the parsed output. */
export function parse<T extends ZodType>(schema: T, data: unknown): T['_output'] {
  const r = schema.safeParse(data);
  if (!r.success) throw new ValidationError(fieldErrorsOf(r.error));
  return r.data;
}
