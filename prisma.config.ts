import { defineConfig } from 'prisma/config';

// Prisma 7 doesn't read .env itself. Load it when present (local dev); in
// Docker/Railway the variables come from the environment.
try {
  process.loadEnvFile();
} catch {
  /* no .env file — rely on the real environment */
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    url: process.env.DATABASE_URL ?? '',
  },
});
