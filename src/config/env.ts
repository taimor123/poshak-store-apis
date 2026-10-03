import { z } from 'zod';

/**
 * Environment, validated once at boot (docs/DEVOPS/ENVIRONMENT_VARIABLES.md).
 * Read env only through `env` — never `process.env.X` elsewhere.
 */
const bool = z
  .enum(['true', 'false', ''])
  .optional()
  .transform((v) => v === 'true');

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  /** Exact origin of poshak-store-app. CORS allows only this (credentials on). */
  WEB_ORIGIN: z.string().url().default('http://localhost:3000'),
  SITE_URL: z.string().url().default('http://localhost:3000'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  GUEST_TOKEN_SECRET: z.string().min(32, 'GUEST_TOKEN_SECRET must be at least 32 characters'),
  COOKIE_DOMAIN: z.string().optional().transform((v) => v || undefined),
  /** Secure cookies; defaults to true in production. */
  COOKIE_SECURE: z.enum(['true', 'false', '']).optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  RESEND_API_KEY: z.string().optional().transform((v) => v || undefined),
  EMAIL_FROM: z.string().default('Poshak <orders@poshak.pk>'),
  CLOUDINARY_CLOUD_NAME: z.string().optional().transform((v) => v || undefined),
  CLOUDINARY_API_KEY: z.string().optional().transform((v) => v || undefined),
  CLOUDINARY_API_SECRET: z.string().optional().transform((v) => v || undefined),
  /**
   * Shared secret with poshak-store-app. The app calls the API from its server,
   * so it forwards the shopper's IP in x-poshak-client-ip; the API trusts that
   * header only when x-poshak-proxy-secret matches. Unset → use the socket IP.
   */
  INTERNAL_PROXY_SECRET: z.string().min(32, 'INTERNAL_PROXY_SECRET must be at least 32 characters').optional().or(z.literal('').transform(() => undefined)),
  /** Disable the in-process cron (tests, or a second instance). */
  DISABLE_CRON: bool,
});

export type Env = z.infer<typeof EnvSchema> & { cookieSecure: boolean };

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment:\n${issues}`);
  }
  const e = parsed.data;
  const cookieSecure = e.COOKIE_SECURE ? e.COOKIE_SECURE === 'true' : e.NODE_ENV === 'production';
  return { ...e, cookieSecure };
}

let current: Env | undefined;

/** The validated environment. Loads .env (if present) on first access. */
export function env(): Env {
  if (!current) {
    try {
      process.loadEnvFile();
    } catch {
      /* no .env file — rely on the real environment */
    }
    current = loadEnv();
  }
  return current;
}

/** Tests only: replace the environment. */
export function setEnv(e: Env) {
  current = e;
}
