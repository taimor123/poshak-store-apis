import { describe, expect, it } from 'vitest';
import { guestTokenFor, isValidGuestToken } from '../../src/auth/guestToken.js';
import { passwordProblem } from '../../src/auth/password.js';
import { loadEnv } from '../../src/config/env.js';
import { shouldRoll } from '../../src/auth/session.js';
import { lockoutFor } from '../../src/services/auth.service.js';
import { applyListing, type ProductCard } from '../../src/services/catalog.service.js';
import { canTransition } from '../../src/services/order.service.js';
import { resolveCells } from '../../src/services/sizing.service.js';
import { zPakPhone } from '../../src/validation/primitives.js';

describe('sizing.resolveCells — three-level override (SIZE_SYSTEM.md)', () => {
  const chartCells = [
    { size: 'M', dimension: 'chest', valueInches: 40 },
    { size: 'M', dimension: 'length', valueInches: 38 },
    { size: 'L', dimension: 'chest', valueInches: 43 },
    { size: 'L', dimension: 'length', valueInches: 38.5 },
  ];

  it('uses the product override when present, the category cell otherwise', () => {
    const rows = resolveCells({ dimensions: ['chest', 'length'], offeredSizes: ['M', 'L'], chartCells, overrides: [{ size: 'M', dimension: 'chest', valueInches: 38 }] });
    expect(rows).toEqual([
      { size: 'M', values: { chest: 38, length: 38 } },
      { size: 'L', values: { chest: 43, length: 38.5 } },
    ]);
  });

  it('renders only offered sizes, and null for missing cells', () => {
    const rows = resolveCells({ dimensions: ['chest', 'hip'], offeredSizes: ['L'], chartCells, overrides: [] });
    expect(rows).toEqual([{ size: 'L', values: { chest: 43, hip: null } }]);
  });
});

describe('listing filters + facets', () => {
  const card = (slug: string, fabric: string, pricePaisa: number, sizes: [string, number][], extra: Partial<ProductCard> = {}): ProductCard => ({
    id: slug, slug, name: slug, code: slug, mode: sizes.length ? 'STITCHED' : 'UNSTITCHED', category: { slug: 'c', name: 'C' }, parentCategory: null,
    pricePaisa, compareAtPaisa: null, badge: null, fabric, colour: null, image: null,
    stock: { total: sizes.reduce((a, [, n]) => a + n, 0) || 5, low: false },
    sizes: sizes.map(([label, stock]) => ({ label, stock, variantId: `${slug}-${label}` })), variantId: sizes.length ? null : `${slug}-v`, publishedAt: '2026-01-01T00:00:00Z', ...extra,
  });
  const cards = [
    card('a', 'Lawn', 4000_00, [['S', 1], ['M', 0]]),
    card('b', 'Silk', 12000_00, [['M', 2]]),
    card('c', 'Lawn', 6000_00, []),
    card('d', 'Lawn', 3000_00, [['M', 0]], { stock: { total: 0, low: false } }),
  ];

  it('filters by fabric and counts facets ignoring their own filter', () => {
    const r = applyListing(cards, { fabric: ['Lawn'], limit: 24 });
    expect(r.items.map((i) => i.slug).sort()).toEqual(['a', 'c', 'd']);
    expect(r.facets.fabric).toEqual([{ value: 'Lawn', count: 3 }, { value: 'Silk', count: 1 }]);
  });

  it('size filter matches only in-stock offered sizes', () => {
    expect(applyListing(cards, { size: ['M'], limit: 24 }).items.map((i) => i.slug)).toEqual(['b']);
  });

  it('sorts by price and puts sold-out products last', () => {
    expect(applyListing(cards, { sort: 'price_asc', limit: 24 }).items.map((i) => i.slug)).toEqual(['a', 'c', 'b', 'd']);
  });

  it('paginates with an opaque cursor', () => {
    const p1 = applyListing(cards, { sort: 'price_asc', limit: 2 });
    const p2 = applyListing(cards, { sort: 'price_asc', limit: 2, cursor: p1.nextCursor! });
    expect([...p1.items, ...p2.items].map((i) => i.slug)).toEqual(['a', 'c', 'b', 'd']);
    expect(p2.nextCursor).toBeNull();
  });
});

describe('order transition table (ORDER_LIFECYCLE.md)', () => {
  it.each([
    ['PENDING', 'CONFIRMED', 'ADMIN', true],
    ['PENDING', 'CONFIRMED', 'CUSTOMER', false],
    ['PENDING', 'CANCELLED', 'CUSTOMER', true],
    ['PACKED', 'CANCELLED', 'CUSTOMER', false],
    ['PACKED', 'CANCELLED', 'ADMIN', true],
    ['PENDING', 'SHIPPED', 'ADMIN', false],
    ['DELIVERED', 'COMPLETED', 'SYSTEM', true],
    ['DELIVERED', 'COMPLETED', 'ADMIN', false],
    ['COMPLETED', 'CANCELLED', 'ADMIN', false],
  ] as const)('%s → %s by %s: %s', (from, to, actor, ok) => {
    expect(canTransition(from, to, actor)).toBe(ok);
  });
});

describe('auth rules', () => {
  it('lockout curve: 5 → 1 min, 10 → 15 min, 20 → 1 h', () => {
    expect(lockoutFor(4)).toBe(0);
    expect(lockoutFor(5)).toBe(60_000);
    expect(lockoutFor(10)).toBe(900_000);
    expect(lockoutFor(20)).toBe(3_600_000);
  });

  it('rejects common passwords and ones containing the email name', () => {
    expect(passwordProblem('password123')).toMatch(/too common/);
    expect(passwordProblem('ayeshakhan2026', 'ayeshakhan@x.pk')).toMatch(/email/);
    expect(passwordProblem('mint-chai-on-sunday')).toBeNull();
  });

  it('customer sessions roll after a day; admin sessions never do', () => {
    const now = Date.now() / 1000;
    expect(shouldRoll({ sub: 'u', role: 'CUSTOMER', sv: 0, iat: now - 2 * 86400 })).toBe(true);
    expect(shouldRoll({ sub: 'u', role: 'CUSTOMER', sv: 0, iat: now - 3600 })).toBe(false);
    expect(shouldRoll({ sub: 'u', role: 'ADMIN', sv: 0, iat: now - 2 * 86400 })).toBe(false);
  });

  it('guest tokens are per-order and constant-time checked', () => {
    const t = guestTokenFor('PSK-202610-0001');
    expect(isValidGuestToken('PSK-202610-0001', t)).toBe(true);
    expect(isValidGuestToken('PSK-202610-0002', t)).toBe(false);
    expect(isValidGuestToken('PSK-202610-0001', undefined)).toBe(false);
  });
});

describe('validation primitives', () => {
  it.each([
    ['0300 1234567', '+923001234567'],
    ['0300-1234567', '+923001234567'],
    ['+923001234567', '+923001234567'],
  ])('normalizes %s', (input, out) => {
    expect(zPakPhone.parse(input)).toBe(out);
  });

  it.each(['03001234', '04001234567', '+9230012345678'])('rejects %s', (input) => {
    expect(zPakPhone.safeParse(input).success).toBe(false);
  });

  it('rejects an invalid environment at boot', () => {
    expect(() => loadEnv({ PORT: 'abc' })).toThrow(/Invalid environment/);
  });
});
