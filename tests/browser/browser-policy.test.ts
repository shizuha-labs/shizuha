/**
 * BRW-38 (BRW-32 G1) — browser default-mode policy.
 *
 * Locks the G1 contract: sensitive surfaces (X, gov portals, banking) resolve
 * to `human` mode by default, explicit mode wins, and non-sensitive targets
 * fall back to the configured default (`fast` unless overridden).
 */
import { describe, it, expect } from 'vitest';
import {
  isSensitiveHost,
  resolveBrowserMode,
  DEFAULT_SENSITIVE_HOSTS,
} from '../../src/config/browser-policy.js';

describe('isSensitiveHost', () => {
  it('matches exact sensitive hosts', () => {
    expect(isSensitiveHost('https://x.com/home')).toBe(true);
    expect(isSensitiveHost('https://twitter.com/')).toBe(true);
    expect(isSensitiveHost('https://incometax.gov.in/')).toBe(true);
    expect(isSensitiveHost('https://mca.gov.in/')).toBe(true);
  });

  it('matches subdomains of wildcard patterns', () => {
    expect(isSensitiveHost('https://www.x.com/')).toBe(true);
    expect(isSensitiveHost('https://eportal.incometax.gov.in/')).toBe(true);
    expect(isSensitiveHost('https://www.mca.gov.in/')).toBe(true);
  });

  it('does not match non-sensitive hosts', () => {
    expect(isSensitiveHost('https://example.com/')).toBe(false);
    expect(isSensitiveHost('https://shizuha.com/')).toBe(false);
    expect(isSensitiveHost('https://github.com/')).toBe(false);
  });

  it('handles malformed URLs without throwing', () => {
    expect(isSensitiveHost('not a url')).toBe(false);
    expect(isSensitiveHost('')).toBe(false);
  });

  it('respects a custom sensitiveHosts override', () => {
    expect(isSensitiveHost('https://internal.example.com/', ['*.example.com'])).toBe(true);
    expect(isSensitiveHost('https://x.com/', ['*.example.com'])).toBe(false);
  });

  it('defaults to the conservative built-in list when unset', () => {
    expect(DEFAULT_SENSITIVE_HOSTS).toContain('x.com');
    expect(DEFAULT_SENSITIVE_HOSTS).toContain('*.gov.in');
    expect(DEFAULT_SENSITIVE_HOSTS).toContain('*.bank');
  });
});

describe('resolveBrowserMode', () => {
  it('explicit mode wins over everything', () => {
    expect(resolveBrowserMode('https://x.com/', 'fast', {}).mode).toBe('fast');
    expect(resolveBrowserMode('https://example.com/', 'human', {}).mode).toBe('human');
  });

  it('sensitive host forces human when no explicit mode', () => {
    const r = resolveBrowserMode('https://x.com/', undefined, {});
    expect(r.mode).toBe('human');
    expect(r.sensitive).toBe(true);
  });

  it('non-sensitive host falls back to defaultMode or fast', () => {
    expect(resolveBrowserMode('https://example.com/', undefined, {}).mode).toBe('fast');
    expect(resolveBrowserMode('https://example.com/', undefined, { defaultMode: 'human' }).mode).toBe('human');
  });

  it('no URL resolves to defaultMode or fast', () => {
    expect(resolveBrowserMode(undefined, undefined, {}).mode).toBe('fast');
    expect(resolveBrowserMode(undefined, undefined, { defaultMode: 'human' }).mode).toBe('human');
  });

  it('marks sensitive only when the URL matches', () => {
    expect(resolveBrowserMode('https://x.com/', undefined, {}).sensitive).toBe(true);
    expect(resolveBrowserMode('https://example.com/', undefined, {}).sensitive).toBe(false);
  });
});
