"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.InventoryService = void 0;
class InventoryService {
    /**
     * Adjusts the stock of a variant and records a ledger entry.
     * Guaranteed to be consistent using Prisma transaction.
     * If stock goes below 0, Prisma will throw an error if DB constraints are in place,
     * or we can manually check here.
     */
    static async adjust(prisma, variantId, delta, reason, source, actorId, refId) {
        return await prisma.$transaction(async (tx) => {
            // We can use an atomic increment
            const updatedVariant = await tx.productVariant.update({
                where: { id: variantId },
                data: {
                    stock: { increment: delta }
                }
            });
            if (updatedVariant.stock < 0) {
                throw new Error(`Insufficient stock for variant ${variantId}. Cannot decrement by ${Math.abs(delta)}.`);
            }
            // Create Ledger entry
            const ledger = await tx.inventoryLedger.create({
                data: {
                    variantId,
                    delta,
                    reason,
                    source,
                    refId,
                    actorId,
                    balanceAfter: updatedVariant.stock
                }
            });
            return { variant: updatedVariant, ledger };
        });
    }
}
exports.InventoryService = InventoryService;
