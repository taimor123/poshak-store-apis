import { z } from 'zod';
import { ADJUST_REASONS } from '../services/inventory.service.js';
import { RETURN_REASONS } from '../services/returns.service.js';
import { zEmail, zId, zName, zNote, zPaisa, zPakPhone, zPassword, zQty, zSlug, zText } from './primitives.js';

// Domain schemas (VALIDATION_RULES.md §Domain schemas). Controllers consume the
// parsed output only — raw input never reaches services.

const csv = z
  .string()
  .optional()
  .transform((s) => (s ? s.split(',').map((x) => x.trim()).filter(Boolean).slice(0, 20) : undefined));

/** Forgiving reads: invalid filter values are dropped, not rejected. */
export const listingQuery = z.object({
  fabric: csv,
  price: z.enum(['u5', '5-10', '10-20', 'o20']).optional().catch(undefined),
  size: csv,
  sale: z.enum(['1', 'true']).optional().catch(undefined).transform((v) => !!v),
  inStock: z.enum(['1', 'true']).optional().catch(undefined).transform((v) => !!v),
  sort: z.enum(['new', 'price_asc', 'price_desc']).optional().catch(undefined),
  cursor: z.string().max(64).optional().catch(undefined),
  limit: z.coerce.number().int().min(1).max(60).default(24).catch(24),
});

// ─── Auth ───────────────────────────────────────────────────────────────────

export const registerSchema = z.object({ email: zEmail, password: zPassword, name: zName, phone: zPakPhone.optional() });
export const loginSchema = z.object({ email: zEmail, password: z.string().min(1, 'Enter your password').max(200) });
export const forgotSchema = z.object({ email: zEmail });
export const resetSchema = z.object({ token: z.string().min(10).max(200), password: zPassword });
export const changePasswordSchema = z.object({ currentPassword: z.string().max(200).default(''), newPassword: zPassword });

// ─── Cart ───────────────────────────────────────────────────────────────────

export const addLineSchema = z.object({ variantId: zId, qty: zQty.default(1) });
export const setQtySchema = z.object({ qty: z.number().int().min(0).max(10) });

// ─── Checkout ───────────────────────────────────────────────────────────────

export const checkoutSchema = z.object({
  contact: z.object({ email: zEmail, phone: zPakPhone }),
  address: z.object({
    name: zName,
    phone: zPakPhone.optional(),
    line1: zText(200).pipe(z.string().min(10, 'Add house number, street and area so the rider can find you')),
    city: zText(60).pipe(z.string().min(1, 'Choose your city')),
    province: zText(60).optional(),
    notes: zNote.optional(),
  }),
  paymentMethod: z.literal('COD'),
  deliveryMethod: z.enum(['STANDARD', 'EXPRESS']).default('STANDARD'),
  clientTotalPaisa: zPaisa,
});
export const idempotencyKeySchema = z.string().uuid('Idempotency-Key must be a UUID');

export const cancelSchema = z.object({ reason: zText(200).pipe(z.string().min(2, 'Tell us why you’re cancelling')) });
export const returnSchema = z.object({
  items: z.array(z.object({ orderItemId: zId, qty: z.number().int().min(1).max(10) })).min(1).max(20),
  reason: z.enum(RETURN_REASONS),
  note: zNote.optional(),
  photoUrls: z.array(z.string().url().max(500)).max(6).optional(),
  bankDetails: z.record(z.string().max(40), z.string().max(120)).optional(),
});

// ─── Account ────────────────────────────────────────────────────────────────

export const profileSchema = z.object({ name: zName.optional(), phone: zPakPhone.nullable().optional() });
export const addressSchema = z.object({
  name: zName,
  phone: zPakPhone,
  line1: zText(200).pipe(z.string().min(10, 'Add house number, street and area')),
  city: zText(60).pipe(z.string().min(1)),
  province: zText(60).optional(),
  postalCode: zText(10).optional(),
  notes: zNote.optional(),
  isDefault: z.boolean().optional(),
});

// ─── Admin ──────────────────────────────────────────────────────────────────

const fabricContent = z.object({ piece: z.enum(['SHIRT', 'DUPATTA', 'TROUSER']), detail: zText(60).optional(), fabric: zText(80).pipe(z.string().min(2)), lengthMeters: z.number().min(0.1).max(99.9) });

export const productSchema = z.object({
  categoryId: zId,
  name: zText(120).pipe(z.string().min(2)),
  slug: zSlug.optional(),
  description: zText(4000).pipe(z.string().min(1)),
  pricePaisa: zPaisa.pipe(z.number().min(1)),
  compareAtPaisa: zPaisa.nullable().optional(),
  fitNote: zText(200).nullable().optional(),
  isFinalSale: z.boolean().optional(),
  attributes: z.record(z.string().max(40), z.union([z.string().max(200), z.array(z.string().max(80)).max(20), z.boolean(), z.number()]).nullable()).optional(),
  fabricContents: z.array(fabricContent).max(10).optional(),
});
export const productPatchSchema = productSchema.partial().extend({ status: z.enum(['DRAFT', 'PUBLISHED', 'ARCHIVED']).optional() });

export const variantsSchema = z.object({
  variants: z.array(z.object({ size: z.string().max(12).nullable().optional(), color: zText(30).nullable().optional(), pricePaisa: zPaisa.nullable().optional() })).min(1).max(40),
});
export const sizeOverridesSchema = z.object({
  overrides: z.array(z.object({ size: z.string().max(12), dimension: z.string().max(30), valueInches: z.number() })).max(200),
  fitNote: zText(200).nullable().optional(),
});
export const imagesSchema = z.object({ images: z.array(z.object({ url: z.string().url().max(500), altText: zText(200), isCover: z.boolean().optional() })).max(12) });

export const stockAdjustSchema = z.object({ variantId: zId, delta: z.number().int().refine((n) => n !== 0, 'Enter a non-zero amount'), reason: z.enum(ADJUST_REASONS), note: zNote.optional() });

export const transitionSchema = z.object({
  to: z.enum(['PENDING', 'CONFIRMED', 'PACKED', 'SHIPPED', 'DELIVERED', 'COMPLETED', 'CANCELLED', 'RETURN_REQUESTED', 'RETURNED', 'REFUNDED']),
  note: zNote.optional(),
  reason: zNote.optional(),
  courier: zText(40).optional(),
  trackingNo: zText(60).optional(),
});
export const refundSchema = z.object({ amountPaisa: zPaisa.pipe(z.number().min(1)), method: z.enum(['bank-transfer', 'jazzcash', 'easypaisa', 'cash', 'gateway']), reference: zText(80).optional(), reason: zText(200).pipe(z.string().min(2)) });
export const returnDecisionSchema = z.object({ approve: z.boolean(), note: zText(300).pipe(z.string().min(2, 'Add a note for the customer')) });
export const returnReceiveSchema = z.object({ items: z.array(z.object({ id: zId, qcOutcome: z.enum(['SELLABLE', 'DAMAGED']) })).min(1) });

export const categorySchema = z.object({
  name: zText(60).pipe(z.string().min(2)),
  slug: zSlug.optional(),
  parentId: zId.nullable().optional(),
  description: zText(300).nullable().optional(),
  sizeMode: z.enum(['STITCHED', 'UNSTITCHED', 'NONE']),
  sizeChartId: zId.nullable().optional(),
  attributeSetId: zId.nullable().optional(),
  sortOrder: z.number().int().min(0).max(999).optional(),
  isActive: z.boolean().optional(),
});
export const sizeChartSchema = z.object({
  name: zText(60).pipe(z.string().min(2)),
  dimensions: z.array(z.string().regex(/^[a-z][a-zA-Z]{0,29}$/, 'Use a short key like chest')).min(1).max(10),
  cells: z.array(z.object({ size: z.string().max(12), dimension: z.string().max(30), valueInches: z.number() })).max(200),
});
export const attributeSetSchema = z.object({
  name: zText(60).pipe(z.string().min(2)),
  definitions: z
    .array(
      z.object({
        key: z.string().regex(/^[a-z][a-zA-Z0-9]{0,39}$/),
        label: zText(60),
        type: z.enum(['SELECT', 'MULTI_SELECT', 'TEXT', 'BOOLEAN', 'NUMBER']),
        filterable: z.boolean().optional(),
        required: z.boolean().optional(),
        options: z.array(z.object({ value: zText(60), label: zText(60), active: z.boolean().optional() })).max(100).optional(),
      }),
    )
    .max(40),
});
export const collectionSchema = z.object({ name: zText(60).pipe(z.string().min(2)), slug: zSlug.optional(), type: z.enum(['MANUAL', 'AUTO_NEW', 'AUTO_SALE']), productIds: z.array(zId).max(200).optional(), bannerUrls: z.array(z.string().url()).max(5).optional(), active: z.boolean().optional() });
export const zonesSchema = z.object({
  zones: z
    .array(z.object({ city: zText(60).pipe(z.string().min(2)), zone: zText(10), feePaisa: zPaisa, estimateText: zText(40), expressAvailable: z.boolean().default(false), active: z.boolean().default(true) }))
    .min(1)
    .max(300),
});
