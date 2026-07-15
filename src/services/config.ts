import { PrismaClient } from '@prisma/client'

export class ConfigService {
  /**
   * Retrieves a specific configuration by key.
   */
  static async get(prisma: PrismaClient, key: string): Promise<any | null> {
    const config = await prisma.storeConfig.findUnique({
      where: { key }
    });
    return config?.value ?? null;
  }

  /**
   * Updates or creates a configuration key.
   */
  static async set(prisma: PrismaClient, key: string, value: any): Promise<void> {
    await prisma.storeConfig.upsert({
      where: { key },
      update: { value },
      create: { key, value }
    });
  }
}
