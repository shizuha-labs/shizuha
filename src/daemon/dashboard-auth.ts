/**
 * Dashboard authentication — password-based login with session cookies.
 *
 * Default credentials: shizuha / shizuha (set on first `shizuha up`).
 * Credentials stored in ~/.shizuha/dashboard.json with scrypt-hashed password.
 * Sessions are in-memory (daemon restart = everyone re-logs in).
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

const DASHBOARD_AUTH_FILE = path.join(
  process.env['HOME'] ?? '~',
  '.shizuha',
  'dashboard.json',
);

const DEFAULT_USERNAME = 'shizuha';
const DEFAULT_PASSWORD = 'shizuha';

// Session management
const sessions = new Map<string, { username: string; createdAt: number }>();
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

interface DashboardCredentials {
  username: string;
  passwordHash: string;
  salt: string;
  createdAt: string;
  changedAt?: string;
}

function hashPassword(password: string, salt: string): string {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function readCredentials(): DashboardCredentials | null {
  try {
    const raw = fs.readFileSync(DASHBOARD_AUTH_FILE, 'utf-8');
    return JSON.parse(raw) as DashboardCredentials;
  } catch {
    return null;
  }
}

function writeCredentials(creds: DashboardCredentials): void {
  const dir = path.dirname(DASHBOARD_AUTH_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  fs.writeFileSync(DASHBOARD_AUTH_FILE, JSON.stringify(creds, null, 2), {
    mode: 0o600,
  });
}

/**
 * Ensure default credentials exist. Called on daemon startup.
 * Returns true if credentials were created (first run).
 */
export function ensureDashboardCredentials(): boolean {
  const existing = readCredentials();
  if (existing) return false;

  const salt = crypto.randomBytes(32).toString('hex');
  const passwordHash = hashPassword(DEFAULT_PASSWORD, salt);

  writeCredentials({
    username: DEFAULT_USERNAME,
    passwordHash,
    salt,
    createdAt: new Date().toISOString(),
  });

  return true;
}

/**
 * Validate username + password. Returns session token on success.
 */
export function login(
  username: string,
  password: string,
): { ok: true; token: string } | { ok: false; error: string } {
  const creds = readCredentials();
  if (!creds) {
    return { ok: false, error: 'No dashboard credentials configured' };
  }

  if (username !== creds.username) {
    return { ok: false, error: 'Invalid username or password' };
  }

  const hash = hashPassword(password, creds.salt);
  if (!crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(creds.passwordHash))) {
    return { ok: false, error: 'Invalid username or password' };
  }

  // Create session
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { username, createdAt: Date.now() });

  return { ok: true, token };
}

/**
 * Validate a session token.
 */
export function validateSession(token: string): { valid: boolean; username?: string } {
  const session = sessions.get(token);
  if (!session) return { valid: false };

  if (Date.now() - session.createdAt > SESSION_TTL_MS) {
    sessions.delete(token);
    return { valid: false };
  }

  return { valid: true, username: session.username };
}

/**
 * Destroy a session.
 */
export function logout(token: string): void {
  sessions.delete(token);
}

/**
 * Change the dashboard password. Requires current password for verification.
 */
export function changePassword(
  currentPassword: string,
  newPassword: string,
): { ok: true } | { ok: false; error: string } {
  const creds = readCredentials();
  if (!creds) {
    return { ok: false, error: 'No dashboard credentials configured' };
  }

  // Verify current password
  const currentHash = hashPassword(currentPassword, creds.salt);
  if (!crypto.timingSafeEqual(Buffer.from(currentHash), Buffer.from(creds.passwordHash))) {
    return { ok: false, error: 'Current password is incorrect' };
  }

  if (newPassword.length < 4) {
    return { ok: false, error: 'Password must be at least 4 characters' };
  }

  // Update password
  const newSalt = crypto.randomBytes(32).toString('hex');
  const newHash = hashPassword(newPassword, newSalt);

  writeCredentials({
    ...creds,
    passwordHash: newHash,
    salt: newSalt,
    changedAt: new Date().toISOString(),
  });

  // Invalidate all sessions (force re-login)
  sessions.clear();

  return { ok: true };
}

/**
 * Check if the default password is still in use.
 */
export function isDefaultPassword(): boolean {
  const creds = readCredentials();
  if (!creds) return false;
  const hash = hashPassword(DEFAULT_PASSWORD, creds.salt);
  try {
    return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(creds.passwordHash));
  } catch {
    return false;
  }
}

/**
 * Extract session token from cookie header.
 */
export function extractSessionToken(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(/(?:^|;\s*)shizuha_session=([^;]+)/);
  return match?.[1] ?? null;
}
