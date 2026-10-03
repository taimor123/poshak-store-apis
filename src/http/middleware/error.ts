import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { DomainError, HTTP_STATUS, type Envelope } from '../errors.js';

/** Unknown route → NOT_FOUND envelope. */
export const notFound: RequestHandler = (req, res) => {
  const body: Envelope<never> = { ok: false, error: { code: 'NOT_FOUND', message: `No route for ${req.method} ${req.path}` } };
  res.status(404).json(body);
};

/**
 * Last middleware. DomainError → its status + envelope. ZodError → VALIDATION.
 * Anything else is a bug: log with full context, return a generic INTERNAL —
 * internals never reach the client.
 */
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (err instanceof DomainError) {
    const body: Envelope<never> = {
      ok: false,
      error: { code: err.code, message: err.message, ...(err.fieldErrors && { fieldErrors: err.fieldErrors }), ...(err.details !== undefined && { details: err.details }) },
    };
    res.status(HTTP_STATUS[err.code]).json(body);
    return;
  }
  if (err instanceof ZodError) {
    const fieldErrors = Object.fromEntries(err.issues.map((i) => [i.path.join('.') || '_', i.message]));
    res.status(400).json({ ok: false, error: { code: 'VALIDATION', message: 'Some fields need attention', fieldErrors } } satisfies Envelope<never>);
    return;
  }
  // Malformed JSON bodies from express.json()
  if (typeof err === 'object' && err !== null && 'type' in err && err.type === 'entity.parse.failed') {
    res.status(400).json({ ok: false, error: { code: 'VALIDATION', message: 'Request body is not valid JSON' } } satisfies Envelope<never>);
    return;
  }
  req.log.error({ err }, 'unhandled error');
  res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: 'Something went wrong' } } satisfies Envelope<never>);
};
