import { execSync } from 'node:child_process';

/** Applies migrations to the test database once per run (unit tests don't need it, but it's cheap). */
export default function setup() {
  const url = process.env.TEST_DATABASE_URL ?? 'postgresql://poshak:poshak@localhost:5433/poshak_test';
  execSync('npx prisma migrate deploy', { env: { ...process.env, DATABASE_URL: url }, stdio: 'pipe' });
}
