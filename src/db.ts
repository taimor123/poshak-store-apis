import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client.js';
import { env } from './config/env.js';

// The single Prisma client. Only src/services/** (and seed/tests) may import it —
// controllers stay Prisma-free (docs/DATABASE/PRISMA_GUIDELINES.md).

export type Db = PrismaClient;
export type Tx = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];

let client: PrismaClient | undefined;

export function createPrisma(url: string) {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
}

export function prisma(): PrismaClient {
  if (!client) client = createPrisma(env().DATABASE_URL);
  return client;
}

export async function disconnect() {
  await client?.$disconnect();
  client = undefined;
}
