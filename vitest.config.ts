import { defineConfig } from 'vitest/config';

const TEST_DB = process.env.TEST_DATABASE_URL ?? 'postgresql://poshak:poshak@localhost:5433/poshak_test';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/globalSetup.ts'],
    // Integration files share one database: run them one at a time.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATABASE_URL: TEST_DB,
      JWT_SECRET: 'test-jwt-secret-0123456789abcdef0123456789',
      GUEST_TOKEN_SECRET: 'test-guest-secret-0123456789abcdef012345',
      WEB_ORIGIN: 'http://localhost:3000',
      SITE_URL: 'http://localhost:3000',
      COOKIE_SECURE: 'false',
      DISABLE_CRON: 'true',
      RESEND_API_KEY: '',
    },
  },
});
