import { describe, expect, it } from 'vitest';
import { decodeBearerExpMs } from '../src/tools/mcp/client.js';

/**
 * PLS-115: the proactive MCP token refresh schedules itself off the JWT `exp`
 * decoded from the connection's auth header. decodeBearerExpMs is the pure core
 * of that — it must handle base64url payloads (no '=' padding, '-'/'_' alphabet),
 * the optional `Bearer ` prefix, the delegated Shizuha header names, and degrade
 * to null (→ the reactive 401 path stays in charge) for opaque / malformed tokens.
 */

// Build an unsigned JWT-shaped token with the given payload (base64url, unpadded).
function jwt(payload: Record<string, unknown>): string {
  const b64url = (obj: unknown) =>
    Buffer.from(JSON.stringify(obj)).toString('base64').replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${b64url({ alg: 'RS256', typ: 'JWT' })}.${b64url(payload)}.sig`;
}

describe('PLS-115 decodeBearerExpMs', () => {
  it('decodes exp (seconds) → epoch ms from an Authorization: Bearer header', () => {
    const exp = 1_900_000_000; // far-future seconds
    expect(decodeBearerExpMs({ Authorization: `Bearer ${jwt({ exp })}` })).toBe(exp * 1000);
  });

  it('accepts a token without the Bearer prefix', () => {
    const exp = 1_888_000_000;
    expect(decodeBearerExpMs({ authorization: jwt({ exp }) })).toBe(exp * 1000);
  });

  it('reads the delegated X-Shizuha-User-Authorization header', () => {
    const exp = 1_777_000_000;
    expect(decodeBearerExpMs({ 'X-Shizuha-User-Authorization': `Bearer ${jwt({ exp })}` })).toBe(exp * 1000);
  });

  it('handles base64url payloads needing padding (- and _ alphabet)', () => {
    // Pick a payload whose base64 contains + and / so the url-safe round-trip is exercised.
    const exp = 2_000_000_123;
    const token = jwt({ exp, sub: 'agent/ryo??>>', scope: 'pulse+connect/all' });
    expect(token).not.toContain('=');
    expect(decodeBearerExpMs({ Authorization: `Bearer ${token}` })).toBe(exp * 1000);
  });

  it('returns null for an opaque (non-JWT) token → reactive path stays in charge', () => {
    expect(decodeBearerExpMs({ Authorization: 'Bearer opaque-not-a-jwt' })).toBeNull();
  });

  it('returns null for a JWT without an exp claim', () => {
    expect(decodeBearerExpMs({ Authorization: `Bearer ${jwt({ sub: 'x' })}` })).toBeNull();
  });

  it('returns null when there is no auth header (only metadata headers)', () => {
    expect(decodeBearerExpMs({ 'X-Organization-ID': '1', 'Content-Type': 'application/json' })).toBeNull();
  });

  it('returns null for undefined / empty headers', () => {
    expect(decodeBearerExpMs(undefined)).toBeNull();
    expect(decodeBearerExpMs({})).toBeNull();
  });

  it('ignores a malformed auth value and falls through to a valid delegated header', () => {
    const exp = 1_950_000_000;
    expect(
      decodeBearerExpMs({
        Authorization: 'Bearer not.a.valid.jwt.too.many.parts',
        'X-Shizuha-User-Authorization': `Bearer ${jwt({ exp })}`,
      }),
    ).toBe(exp * 1000);
  });
});
