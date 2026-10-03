import { pino } from 'pino';

/** Structured JSON logs. Never log full phone numbers or emails — use `maskPhone` / `maskEmail`. */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]', '*.password', '*.passwordHash'],
});

export const maskPhone = (phone: string) => `***${phone.slice(-4)}`;
export const maskEmail = (email: string) => email.replace(/^(.).*(@.*)$/, '$1***$2');
