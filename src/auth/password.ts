import { hash, verify } from '@node-rs/argon2';

// argon2id with the OWASP baseline (AUTH_SECURITY.md): 19 MiB, 2 iterations, parallelism 1.
const OPTIONS = { memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

export const hashPassword = (password: string) => hash(password, OPTIONS);

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

/** A dummy hash so failed logins for unknown emails take the same time (no user-existence oracle). */
let dummy: string | undefined;
export async function burnPasswordCheck(password: string) {
  dummy ??= await hashPassword('timing-equaliser-not-a-real-password');
  await verifyPassword(dummy, password);
}

// Small bundled blocklist. AUTH_SECURITY.md asks for a top-100k breached list +
// zxcvbn; this covers the worst offenders until that list is added.
const COMMON = new Set([
  'password', 'password1', 'password123', '12345678', '123456789', '1234567890', 'qwerty123', 'qwertyuiop',
  'iloveyou', 'admin123', 'welcome1', 'letmein1', 'abc12345', 'pakistan', 'pakistan1', 'pakistan123',
  '11111111', '00000000', 'football', 'baseball', 'sunshine', 'princess', 'passw0rd', 'poshak123',
]);

export function passwordProblem(password: string, email?: string): string | null {
  const p = password.toLowerCase();
  if (COMMON.has(p)) return 'That password is too common. Choose something harder to guess.';
  if (/^(.)\1+$/.test(password)) return 'Avoid repeating a single character.';
  if (email && p.includes(email.split('@')[0]!.toLowerCase())) return 'Don’t include your email in your password.';
  return null;
}
