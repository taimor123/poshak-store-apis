// Error-code registry + response envelope (docs/BACKEND/API_ENDPOINTS.md §Error codes,
// docs/BACKEND/ERROR_HANDLING.md). poshak-store-app keeps its own copy of the same enum.

export const ERROR_CODES = [
  'VALIDATION',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'VARIANT_GONE',
  'STOCK_CONFLICT',
  'PRICE_MISMATCH',
  'ILLEGAL_TRANSITION',
  'RETURN_WINDOW_CLOSED',
  'ITEM_FINAL_SALE',
  'RATE_LIMITED',
  'IDEMPOTENT_REPLAY',
  'INTERNAL',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export const HTTP_STATUS: Record<ErrorCode, number> = {
  VALIDATION: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VARIANT_GONE: 410,
  STOCK_CONFLICT: 409,
  PRICE_MISMATCH: 409,
  ILLEGAL_TRANSITION: 409,
  RETURN_WINDOW_CLOSED: 422,
  ITEM_FINAL_SALE: 422,
  RATE_LIMITED: 429,
  IDEMPOTENT_REPLAY: 200,
  INTERNAL: 500,
};

export type ErrorBody = { code: ErrorCode; message: string; fieldErrors?: Record<string, string>; details?: unknown };
export type Envelope<T> = { ok: true; data: T } | { ok: false; error: ErrorBody };

export const success = <T>(data: T): Envelope<T> => ({ ok: true, data });

/**
 * Expected failure: a business rule said no. Services throw these; the error
 * middleware maps them to HTTP status + envelope. Never throw strings.
 */
export class DomainError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly fieldErrors?: Record<string, string>,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

export class NotFoundError extends DomainError {
  constructor(message = 'Not found') {
    super('NOT_FOUND', message);
  }
}

export class ValidationError extends DomainError {
  constructor(fieldErrors: Record<string, string>, message = 'Some fields need attention') {
    super('VALIDATION', message, fieldErrors);
  }
}
