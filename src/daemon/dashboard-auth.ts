/**
 * Dashboard authentication — password-based login with session cookies.
 *
 * First run never uses a deterministic password: operators may provide
 * SHIZUHA_DASHBOARD_PASSWORD, otherwise a random one-time setup password is
 * generated and printed to the local daemon console/log. Credentials are stored
 * in ~/.shizuha/dashboard.json with a scrypt-hashed password.
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
const DASHBOARD_PASSWORD_ENV = 'SHIZUHA_DASHBOARD_PASSWORD';
const DASHBOARD_USERNAME_ENV = 'SHIZUHA_DASHBOARD_USERNAME';
const MIN_DASHBOARD_PASSWORD_LENGTH = 8;

// Session management
const sessions = new Map<string, { username: string; createdAt: number }>();
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

interface DashboardCredentials {
  username: string;
  passwordHash: string;
  salt: string;
  createdAt: string;
  changedAt?: string;
  /** True for generated one-time setup passwords until the operator changes it. */
  mustChangePassword?: boolean;
  /** Marks credentials created by the non-deterministic first-run flow. */
  provisionedBy?: 'env' | 'generated' | 'rotated-legacy-default';
}

function hashPassword(password: string, salt: string): string {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function constantTimeHexEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function isHistoricalDefaultCredential(creds: DashboardCredentials): boolean {
  if (!creds.salt || !creds.passwordHash) return false;
  try {
    return constantTimeHexEqual(creds.passwordHash, hashPassword(DEFAULT_USERNAME, creds.salt));
  } catch {
    return false;
  }
}

function configuredDashboardUsername(): string {
  const configured = process.env[DASHBOARD_USERNAME_ENV]?.trim();
  return configured || DEFAULT_USERNAME;
}

function configuredDashboardPassword(): string | null {
  const configured = process.env[DASHBOARD_PASSWORD_ENV];
  if (configured == null || configured === '') return null;
  if (configured.length < MIN_DASHBOARD_PASSWORD_LENGTH) {
    throw new Error(`${DASHBOARD_PASSWORD_ENV} must be at least ${MIN_DASHBOARD_PASSWORD_LENGTH} characters`);
  }
  return configured;
}

function generateOneTimePassword(): string {
  return crypto.randomBytes(24).toString('base64url');
}

function createCredentials(
  password: string,
  provisionedBy: NonNullable<DashboardCredentials['provisionedBy']>,
  mustChangePassword: boolean,
  username = configuredDashboardUsername(),
): DashboardCredentials {
  const salt = crypto.randomBytes(32).toString('hex');
  return {
    username,
    passwordHash: hashPassword(password, salt),
    salt,
    createdAt: new Date().toISOString(),
    mustChangePassword,
    provisionedBy,
  };
}

function logGeneratedPassword(password: string, reason: string): void {
  console.warn(
    `[dashboard-auth] ${reason}\n` +
    `[dashboard-auth] Username: ${configuredDashboardUsername()}\n` +
    `[dashboard-auth] One-time setup password: ${password}\n` +
    '[dashboard-auth] This password is printed only to the local daemon console/log; change it immediately after login.',
  );
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
 * Ensure dashboard credentials exist. Called on daemon startup.
 * Returns true if credentials were created or an unsafe legacy first-run
 * credential record was rotated.
 */
export function ensureDashboardCredentials(): boolean {
  const existing = readCredentials();
  const configuredPassword = configuredDashboardPassword();
  if (existing) {
    // If first startup generated a temporary setup password and the operator
    // missed the local log line, allow a later explicit env password to recover
    // the dashboard without manually deleting dashboard.json. Once the operator
    // has changed the password, changedAt/mustChangePassword protect their
    // chosen credential from env churn.
    if (configuredPassword && existing.mustChangePassword === true && !existing.changedAt) {
      const recoveryUsername = process.env[DASHBOARD_USERNAME_ENV]?.trim() || existing.username || DEFAULT_USERNAME;
      writeCredentials(createCredentials(configuredPassword, 'env', false, recoveryUsername));
      console.warn(
        `[dashboard-auth] Replaced temporary dashboard setup credentials for ${recoveryUsername} from ${DASHBOARD_PASSWORD_ENV}.`,
      );
      return true;
    }

    // Historical builds wrote the published default password with no changedAt
    // and no provisionedBy marker. Only rotate metadata-less records after
    // proving their stored hash is the historical default; older/manual custom
    // installs may also lack the new metadata and must keep their known login.
    // If the operator supplied an explicit provisioning password during a true
    // legacy-default upgrade, honor that instead of generating a random secret
    // they would have to scrape from logs. Otherwise rotate the public default
    // to a random local-only setup secret.
    if (!existing.changedAt && !existing.provisionedBy && !existing.mustChangePassword
      && isHistoricalDefaultCredential(existing)) {
      if (configuredPassword) {
        writeCredentials(createCredentials(configuredPassword, 'env', false));
        console.warn(
          `[dashboard-auth] Rotated legacy dashboard default credentials for ${configuredDashboardUsername()} from ${DASHBOARD_PASSWORD_ENV}.`,
        );
        return true;
      }

      const password = generateOneTimePassword();
      writeCredentials(createCredentials(password, 'rotated-legacy-default', true));
      logGeneratedPassword(password, 'Rotated legacy dashboard default credentials.');
      return true;
    }
    return false;
  }

  if (configuredPassword) {
    writeCredentials(createCredentials(configuredPassword, 'env', false));
    console.warn(
      `[dashboard-auth] Created dashboard credentials for ${configuredDashboardUsername()} from ${DASHBOARD_PASSWORD_ENV}.`,
    );
    return true;
  }

  const password = generateOneTimePassword();
  writeCredentials(createCredentials(password, 'generated', true));
  logGeneratedPassword(password, 'Created dashboard credentials with a random one-time setup password.');
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

  if (newPassword.length < MIN_DASHBOARD_PASSWORD_LENGTH) {
    return { ok: false, error: `Password must be at least ${MIN_DASHBOARD_PASSWORD_LENGTH} characters` };
  }

  // Update password
  const newSalt = crypto.randomBytes(32).toString('hex');
  const newHash = hashPassword(newPassword, newSalt);

  writeCredentials({
    ...creds,
    passwordHash: newHash,
    salt: newSalt,
    changedAt: new Date().toISOString(),
    mustChangePassword: false,
  });

  // Invalidate all sessions (force re-login)
  sessions.clear();

  return { ok: true };
}

/**
 * Historical API name used by dashboard routes. It now means the current setup
 * password is temporary and must be changed; no deterministic default password
 * is shipped or checked.
 */
export function isDefaultPassword(): boolean {
  return readCredentials()?.mustChangePassword === true;
}

/**
 * Extract session token from cookie header.
 */
export function extractSessionToken(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(/(?:^|;\s*)shizuha_session=([^;]+)/);
  return match?.[1] ?? null;
}

/**
 * Constant-time credential check used by the daemon's mini-Connect
 * (`AuthService`) to delegate human-user password verification here, so the
 * dashboard password remains the single source of truth.
 */
export function verifyDashboardCredentials(username: string, password: string): boolean {
  const creds = readCredentials();
  if (!creds) return false;
  if (username !== creds.username) return false;
  const hash = hashPassword(password, creds.salt);
  try {
    return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(creds.passwordHash));
  } catch {
    return false;
  }
}

/** Returns the configured dashboard username (or null if uninitialized). */
export function getDashboardUsername(): string | null {
  return readCredentials()?.username ?? null;
}
