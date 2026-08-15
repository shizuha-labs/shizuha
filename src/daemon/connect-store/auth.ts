/**
 * Local auth for the daemon's mini-Connect.
 *
 * Issues HS256 JWTs whose claim shape matches real shizuha-id so the same
 * client code (browser, Kotlin, agent containers) authenticates identically
 * regardless of which backend it's pointing at. Single-user mode: there's
 * one human user (the dashboard owner) and N agent users (one per
 * shizuha-agent container).
 *
 * Signing key: ~/.shizuha/connect-jwt.key (256-bit random, 0o600). Generated
 * once on first boot and reused thereafter so existing clients don't get
 * invalidated by a daemon restart.
 *
 * Password hashing: scrypt (Node built-in) — no external dep.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type { ConnectStore, User } from './sqlite.js';

const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;          // 1 hour, matches shizuha-id
const REFRESH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

export interface JwtClaims {
  user_id: number;
  username: string;
  email: string;
  is_agent: boolean;
  is_staff: boolean;
  is_superuser: boolean;
  organization_memberships: Record<string, string>;
  exp: number;
  iat: number;
  token_type: 'access' | 'refresh';
  jti: string;
}

export interface IssuedTokens {
  access: string;
  refresh: string;
  user: User;
}

function defaultKeyPath(): string {
  return path.join(process.env['HOME'] ?? '~', '.shizuha', 'connect-jwt.key');
}

function loadOrCreateSigningKey(keyPath: string = defaultKeyPath()): Buffer {
  try {
    const raw = fs.readFileSync(keyPath, 'utf-8').trim();
    if (raw.length >= 32) return Buffer.from(raw, 'hex');
  } catch { /* fall through to generate */ }

  const dir = path.dirname(keyPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const key = crypto.randomBytes(32);
  const tmp = `${keyPath}.tmp`;
  fs.writeFileSync(tmp, key.toString('hex'), { mode: 0o600 });
  fs.renameSync(tmp, keyPath);
  return key;
}

function b64urlEncode(s: string | Buffer): string {
  return Buffer.from(s).toString('base64url');
}

function b64urlDecode(s: string): Buffer {
  return Buffer.from(s, 'base64url');
}

// ── Password hashing (scrypt) ─────────────────────────────────────────────

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P,
  });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const N = parseInt(parts[1] ?? '0', 10);
  const r = parseInt(parts[2] ?? '0', 10);
  const p = parseInt(parts[3] ?? '0', 10);
  if (!N || !r || !p) return false;
  const salt = b64urlDecode(parts[4] ?? '');
  const expected = b64urlDecode(parts[5] ?? '');
  let candidate: Buffer;
  try {
    candidate = crypto.scryptSync(password, salt, expected.length, { N, r, p });
  } catch {
    return false;
  }
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

// ── JWT (HS256) ───────────────────────────────────────────────────────────

export interface AuthServiceOptions {
  /** Custom signing-key location. Defaults to ~/.shizuha/connect-jwt.key. */
  keyPath?: string;
  /**
   * Optional fallback verifier called when the local user has no stored hash.
   * Lets the dashboard password (managed by `dashboard-auth.ts`) remain the
   * single source of truth for the human user — mini-Connect delegates to it
   * instead of duplicating the password.
   */
  passwordVerifier?: (username: string, password: string) => boolean;
}

export class AuthService {
  private signingKey: Buffer;
  private passwordVerifier?: (username: string, password: string) => boolean;

  constructor(
    private store: ConnectStore,
    options: AuthServiceOptions | string = {},
  ) {
    // Backwards-compat: allow passing a key path string directly.
    const opts: AuthServiceOptions = typeof options === 'string' ? { keyPath: options } : options;
    this.signingKey = loadOrCreateSigningKey(opts.keyPath ?? defaultKeyPath());
    this.passwordVerifier = opts.passwordVerifier;
  }

  /**
   * Ensure the local human user exists and has a password set. Returns the
   * user. If `password` is provided and the user is new (or has no password),
   * the password is set; otherwise the existing password stays. Used at daemon
   * boot to bootstrap the dashboard owner from their dashboard credentials.
   */
  ensureLocalUser(opts: {
    username: string;
    email?: string;
    displayName?: string;
    password?: string;
  }): User {
    const existing = this.store.getUserByUsername(opts.username);
    if (existing) {
      if (opts.password && !existing.passwordHash) {
        this.store.setPassword(existing.id, hashPassword(opts.password));
      }
      return this.store.getUserByUsername(opts.username)!;
    }
    return this.store.createUser({
      username: opts.username,
      email: opts.email,
      passwordHash: opts.password ? hashPassword(opts.password) : undefined,
      isAgent: false,
      displayName: opts.displayName ?? opts.username,
    });
  }

  /**
   * Idempotent — used by the daemon to register each agent container.
   *
   * Refuses to overwrite an existing human user that happens to share the
   * same username (e.g. a human dashboard owner named "shizuha" and an agent
   * named "Shizuha"). Returns the existing human row unchanged in that case
   * so we don't clobber the dashboard's auth — the agent will then fail to
   * authenticate against mini-Connect with this name, which is the correct
   * outcome for an unresolved username collision.
   */
  ensureAgentUser(opts: {
    username: string;
    agentId: string;
    email?: string;
    displayName?: string;
    password?: string;
  }): User {
    const existing = this.store.getUserByUsername(opts.username);
    if (existing && !existing.isAgent) {
      return existing;
    }
    return this.store.upsertUser({
      username: opts.username,
      email: opts.email,
      passwordHash: opts.password ? hashPassword(opts.password) : undefined,
      isAgent: true,
      agentId: opts.agentId,
      displayName: opts.displayName ?? opts.username,
    });
  }

  /** Returns issued tokens on success, null on bad credentials. */
  login(username: string, password: string): IssuedTokens | null {
    const user = this.store.getUserByUsername(username);
    if (!user) return null;
    let ok = false;
    if (user.passwordHash) {
      ok = verifyPassword(password, user.passwordHash);
    } else if (this.passwordVerifier) {
      ok = this.passwordVerifier(username, password);
    }
    if (!ok) return null;
    return this.issueTokens(user);
  }

  /** Issue tokens for an already-authenticated user (e.g. agent self-auth). */
  issueTokens(user: User): IssuedTokens {
    return {
      access: this.signAccess(user),
      refresh: this.signRefresh(user),
      user,
    };
  }

  signAccess(user: User): string {
    const now = Math.floor(Date.now() / 1000);
    return this.sign({
      user_id: user.id,
      username: user.username,
      email: user.email ?? '',
      is_agent: user.isAgent,
      is_staff: false,
      is_superuser: false,
      organization_memberships: {},
      exp: now + ACCESS_TOKEN_TTL_SECONDS,
      iat: now,
      token_type: 'access',
      jti: crypto.randomUUID(),
    });
  }

  signRefresh(user: User): string {
    const now = Math.floor(Date.now() / 1000);
    return this.sign({
      user_id: user.id,
      username: user.username,
      email: user.email ?? '',
      is_agent: user.isAgent,
      is_staff: false,
      is_superuser: false,
      organization_memberships: {},
      exp: now + REFRESH_TOKEN_TTL_SECONDS,
      iat: now,
      token_type: 'refresh',
      jti: crypto.randomUUID(),
    });
  }

  /**
   * Refresh an access token. Real shizuha-id allows multi-use refresh tokens
   * (until expiry) — we mirror that to keep clients simple. If you want
   * single-use rotation later, track jti in a denylist on use.
   */
  refresh(refreshToken: string): IssuedTokens | null {
    const claims = this.verify(refreshToken);
    if (!claims || claims.token_type !== 'refresh') return null;
    const user = this.store.getUserById(claims.user_id);
    if (!user) return null;
    return this.issueTokens(user);
  }

  /** Verify a JWT. Returns the claims if valid + unexpired, null otherwise. */
  verify(token: string): JwtClaims | null {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [headerB64, payloadB64, sigB64] = parts as [string, string, string];

    let header: { alg?: string; typ?: string };
    try { header = JSON.parse(b64urlDecode(headerB64).toString()); } catch { return null; }
    if (header.alg !== 'HS256') return null;

    const expected = crypto.createHmac('sha256', this.signingKey)
      .update(`${headerB64}.${payloadB64}`).digest();
    const provided = b64urlDecode(sigB64);
    if (expected.length !== provided.length) return null;
    if (!crypto.timingSafeEqual(expected, provided)) return null;

    let claims: JwtClaims;
    try { claims = JSON.parse(b64urlDecode(payloadB64).toString()); } catch { return null; }
    if (typeof claims.exp !== 'number' || claims.exp < Math.floor(Date.now() / 1000)) return null;
    return claims;
  }

  private sign(claims: JwtClaims): string {
    const headerB64 = b64urlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const payloadB64 = b64urlEncode(JSON.stringify(claims));
    const sig = crypto.createHmac('sha256', this.signingKey)
      .update(`${headerB64}.${payloadB64}`).digest('base64url');
    return `${headerB64}.${payloadB64}.${sig}`;
  }
}
