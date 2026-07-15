"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ConfigService = void 0;
class ConfigService {
    /**
     * Retrieves a specific configuration by key.
     */
    static async get(prisma, key) {
        const config = await prisma.storeConfig.findUnique({
            where: { key }
        });
        return config?.value ?? null;
    }
    /**
     * Updates or creates a configuration key.
     */
    static async set(prisma, key, value) {
        await prisma.storeConfig.upsert({
            where: { key },
            update: { value },
            create: { key, value }
        });
    }
}
exports.ConfigService = ConfigService;
