import { createHash, randomBytes } from 'node:crypto';
import { env } from '../config/env.js';
import { prisma } from '../db.js';
import { burnPasswordCheck, hashPassword, passwordProblem, verifyPassword } from '../auth/password.js';
import type { SessionClaims } from '../auth/session.js';
import type { SessionUser } from '../auth/authz.js';
import { DomainError, ValidationError } from '../http/errors.js';
import { logger, maskEmail } from '../logger.js';
import { accountEmails } from './notification.service.js';

/**
 * Email + password accounts (AUTHENTICATION.md, AUTH_SECURITY.md).
 * Email OTP verification and Google sign-in are deferred by the owner
 * (2026-10-03): accounts work without verification for now.
 */

const GENERIC_LOGIN_ERROR = 'Email or password is incorrect';
const RESET_TTL_MS = 30 * 60 * 1000;

/** Lockout curve: 5 fails → 1 min · 10 → 15 min · 20 → 1 h. */
export function lockoutFor(failedLogins: number): number {
  if (failedLogins >= 20) return 60 * 60 * 1000;
  if (failedLogins >= 10) return 15 * 60 * 1000;
  if (failedLogins >= 5) return 60 * 1000;
  return 0;
}

const toSessionUser = (u: { id: string; role: 'CUSTOMER' | 'ADMIN'; name: string; email: string }): SessionUser => ({ id: u.id, role: u.role, name: u.name, email: u.email });

/** Re-validates JWT claims against the DB (closes the revocation gap). */
export async function resolveSessionUser(claims: SessionClaims): Promise<SessionUser | null> {
  const u = await prisma().user.findUnique({ where: { id: claims.sub }, select: { id: true, role: true, name: true, email: true, sessionVersion: true } });
  if (!u || u.sessionVersion !== claims.sv || u.role !== claims.role) return null;
  return toSessionUser(u);
}

export async function register(input: { email: string; password: string; name: string; phone?: string }) {
  const problem = passwordProblem(input.password, input.email);
  if (problem) throw new ValidationError({ password: problem });
  const db = prisma();
  const existing = await db.user.findUnique({ where: { email: input.email }, select: { id: true } });
  if (existing) throw new ValidationError({ email: 'An account with this email already exists. Sign in instead.' });
  const user = await db.user.create({
    data: { email: input.email, name: input.name, phone: input.phone, passwordHash: await hashPassword(input.password) },
    select: { id: true, role: true, name: true, email: true, sessionVersion: true },
  });
  logger.info({ userId: user.id }, 'account registered');
  return { user: toSessionUser(user), sessionVersion: user.sessionVersion };
}

export async function login(input: { email: string; password: string }) {
  const db = prisma();
  const u = await db.user.findUnique({
    where: { email: input.email },
    select: { id: true, role: true, name: true, email: true, passwordHash: true, sessionVersion: true, failedLogins: true, lockedUntil: true },
  });
  if (!u?.passwordHash) {
    await burnPasswordCheck(input.password);
    throw new DomainError('UNAUTHORIZED', GENERIC_LOGIN_ERROR);
  }
  if (u.lockedUntil && u.lockedUntil > new Date()) throw new DomainError('RATE_LIMITED', 'Too many attempts. Please wait a little and try again.');

  if (!(await verifyPassword(u.passwordHash, input.password))) {
    const failed = u.failedLogins + 1;
    const lock = lockoutFor(failed);
    await db.user.update({ where: { id: u.id }, data: { failedLogins: failed, lockedUntil: lock ? new Date(Date.now() + lock) : null } });
    logger.warn({ email: maskEmail(u.email), failed }, 'login failed');
    throw new DomainError('UNAUTHORIZED', GENERIC_LOGIN_ERROR);
  }
  if (u.failedLogins || u.lockedUntil) await db.user.update({ where: { id: u.id }, data: { failedLogins: 0, lockedUntil: null } });
  return { user: toSessionUser(u), sessionVersion: u.sessionVersion };
}

/** "Log out everywhere": every existing JWT stops working. */
export async function bumpSessionVersion(userId: string) {
  const u = await prisma().user.update({ where: { id: userId }, data: { sessionVersion: { increment: 1 } }, select: { sessionVersion: true } });
  return u.sessionVersion;
}

export async function changePassword(userId: string, input: { currentPassword: string; newPassword: string }) {
  const db = prisma();
  const u = await db.user.findUnique({ where: { id: userId }, select: { email: true, passwordHash: true } });
  if (!u) throw new DomainError('UNAUTHORIZED', 'Please sign in again');
  if (u.passwordHash && !(await verifyPassword(u.passwordHash, input.currentPassword))) throw new ValidationError({ currentPassword: 'That’s not your current password' });
  const problem = passwordProblem(input.newPassword, u.email);
  if (problem) throw new ValidationError({ newPassword: problem });
  const updated = await db.user.update({
    where: { id: userId },
    data: { passwordHash: await hashPassword(input.newPassword), sessionVersion: { increment: 1 } },
    select: { id: true, role: true, name: true, email: true, sessionVersion: true },
  });
  accountEmails.passwordChanged(u.email, `${env().SITE_URL}/forgot-password`);
  return { user: toSessionUser(updated), sessionVersion: updated.sessionVersion };
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** Always "succeeds" — the response never reveals whether the email exists. */
export async function forgotPassword(email: string) {
  const db = prisma();
  const u = await db.user.findUnique({ where: { email }, select: { id: true } });
  if (!u) return;
  const token = randomBytes(32).toString('base64url');
  await db.passwordResetToken.create({ data: { userId: u.id, tokenHash: sha256(token), expiresAt: new Date(Date.now() + RESET_TTL_MS) } });
  accountEmails.passwordReset(email, `${env().SITE_URL}/reset-password?token=${token}`);
}

/** Single-use, 30-minute token; all sessions are invalidated on success. */
export async function resetPassword(input: { token: string; password: string }) {
  const db = prisma();
  const row = await db.passwordResetToken.findUnique({ where: { tokenHash: sha256(input.token) }, select: { id: true, userId: true, expiresAt: true, usedAt: true, user: { select: { email: true } } } });
  if (!row || row.usedAt || row.expiresAt < new Date()) throw new ValidationError({ token: 'This reset link has expired. Ask for a new one.' });
  const problem = passwordProblem(input.password, row.user.email);
  if (problem) throw new ValidationError({ password: problem });
  await db.$transaction([
    db.passwordResetToken.update({ where: { id: row.id }, data: { usedAt: new Date() } }),
    db.user.update({ where: { id: row.userId }, data: { passwordHash: await hashPassword(input.password), sessionVersion: { increment: 1 }, failedLogins: 0, lockedUntil: null } }),
  ]);
}
