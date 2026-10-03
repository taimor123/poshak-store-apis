import { pino } from 'pino';

/** Structured JSON logs. Phone numbers must be redacted to last-4 before logging (LOGGING.md). */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
});
