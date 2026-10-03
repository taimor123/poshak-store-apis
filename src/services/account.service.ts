import { prisma } from '../db.js';
import { NotFoundError, ValidationError } from '../http/errors.js';
import { findZone } from './shipping.service.js';

// Profile + saved addresses. Every lookup is scoped by userId (ownership predicate).

const MAX_ADDRESSES = 5;
const addressSelect = { id: true, name: true, phone: true, line1: true, city: true, province: true, postalCode: true, notes: true, isDefault: true } as const;

export async function getProfile(userId: string) {
  const u = await prisma().user.findUnique({ where: { id: userId }, select: { id: true, email: true, name: true, phone: true, role: true, createdAt: true, passwordHash: true } });
  if (!u) throw new NotFoundError('Account not found');
  const { passwordHash, ...rest } = u;
  return { ...rest, hasPassword: !!passwordHash };
}

export async function updateProfile(userId: string, patch: { name?: string; phone?: string | null }) {
  await prisma().user.update({ where: { id: userId }, data: patch });
  return getProfile(userId);
}

export const listAddresses = (userId: string) =>
  prisma().address.findMany({ where: { userId }, orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }], select: addressSelect });

type AddressInput = { name: string; phone: string; line1: string; city: string; province?: string; postalCode?: string; notes?: string; isDefault?: boolean };

export async function createAddress(userId: string, input: AddressInput) {
  const zone = await findZone(input.city);
  const db = prisma();
  const count = await db.address.count({ where: { userId } });
  if (count >= MAX_ADDRESSES) throw new ValidationError({ _: `You can save up to ${MAX_ADDRESSES} addresses. Remove one first.` });
  const makeDefault = input.isDefault || count === 0;
  return db.$transaction(async (tx) => {
    if (makeDefault) await tx.address.updateMany({ where: { userId }, data: { isDefault: false } });
    return tx.address.create({ data: { ...input, city: zone.city, userId, isDefault: makeDefault }, select: addressSelect });
  });
}

async function owned(userId: string, id: string) {
  const a = await prisma().address.findFirst({ where: { id, userId }, select: { id: true, isDefault: true } });
  if (!a) throw new NotFoundError('Address not found');
  return a;
}

export async function updateAddress(userId: string, id: string, patch: Partial<AddressInput>) {
  await owned(userId, id);
  const city = patch.city ? (await findZone(patch.city)).city : undefined;
  const { isDefault, ...rest } = patch;
  await prisma().address.update({ where: { id }, data: { ...rest, ...(city && { city }) } });
  if (isDefault) await setDefaultAddress(userId, id);
  return listAddresses(userId);
}

export async function deleteAddress(userId: string, id: string) {
  const a = await owned(userId, id);
  const db = prisma();
  await db.address.delete({ where: { id } });
  if (a.isDefault) {
    const next = await db.address.findFirst({ where: { userId }, orderBy: { createdAt: 'asc' }, select: { id: true } });
    if (next) await db.address.update({ where: { id: next.id }, data: { isDefault: true } });
  }
  return listAddresses(userId);
}

export async function setDefaultAddress(userId: string, id: string) {
  await owned(userId, id);
  await prisma().$transaction([
    prisma().address.updateMany({ where: { userId }, data: { isDefault: false } }),
    prisma().address.update({ where: { id }, data: { isDefault: true } }),
  ]);
  return listAddresses(userId);
}
