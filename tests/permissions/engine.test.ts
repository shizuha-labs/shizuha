import { describe, it, expect } from 'vitest';
import { PermissionEngine } from '../../src/permissions/engine.js';

describe('PermissionEngine', () => {
  it('allows everything in autonomous mode', () => {
    const engine = new PermissionEngine('autonomous');
    expect(engine.check({ toolName: 'bash', input: {}, riskLevel: 'high' })).toBe('allow');
    expect(engine.check({ toolName: 'write', input: {}, riskLevel: 'medium' })).toBe('allow');
  });

  it('allows low-risk in supervised mode', () => {
    const engine = new PermissionEngine('supervised');
    expect(engine.check({ toolName: 'read', input: {}, riskLevel: 'low' })).toBe('allow');
  });

  it('asks for medium-risk in supervised mode', () => {
    const engine = new PermissionEngine('supervised');
    expect(engine.check({ toolName: 'write', input: {}, riskLevel: 'medium' })).toBe('ask');
  });

  it('denies medium/high-risk in plan mode', () => {
    const engine = new PermissionEngine('plan');
    expect(engine.check({ toolName: 'bash', input: {}, riskLevel: 'high' })).toBe('deny');
    expect(engine.check({ toolName: 'write', input: {}, riskLevel: 'medium' })).toBe('deny');
  });

  it('allows low-risk in plan mode', () => {
    const engine = new PermissionEngine('plan');
    expect(engine.check({ toolName: 'read', input: {}, riskLevel: 'low' })).toBe('allow');
  });

  it('respects explicit rules over mode defaults', () => {
    const engine = new PermissionEngine('supervised', [
      { tool: 'bash', decision: 'allow' },
    ]);
    expect(engine.check({ toolName: 'bash', input: {}, riskLevel: 'high' })).toBe('allow');
  });

  it('supports wildcard rules', () => {
    const engine = new PermissionEngine('supervised', [
      { tool: 'mcp__*', decision: 'allow' },
    ]);
    expect(engine.check({ toolName: 'mcp__pulse__list_tasks', input: {}, riskLevel: 'medium' })).toBe('allow');
  });

  it('remembers session approvals', () => {
    const engine = new PermissionEngine('supervised');
    expect(engine.check({ toolName: 'write', input: {}, riskLevel: 'medium' })).toBe('ask');
    engine.approve('write');
    expect(engine.check({ toolName: 'write', input: {}, riskLevel: 'medium' })).toBe('allow');
  });

  // ── Network Policy Tests ──

  it('denies web_fetch when networkAccess is false', () => {
    const engine = new PermissionEngine('autonomous', [], {
      networkPolicy: { networkAccess: false, allowedHosts: [] },
    });
    expect(engine.check({
      toolName: 'web_fetch',
      input: { url: 'https://example.com' },
      riskLevel: 'medium',
    })).toBe('deny');
  });

  it('allows web_fetch when networkAccess is true and no host filter', () => {
    const engine = new PermissionEngine('autonomous', [], {
      networkPolicy: { networkAccess: true, allowedHosts: [] },
    });
    expect(engine.check({
      toolName: 'web_fetch',
      input: { url: 'https://anything.example.com/page' },
      riskLevel: 'medium',
    })).toBe('allow');
  });

  it('allows web_fetch to matching host in allowlist', () => {
    const engine = new PermissionEngine('autonomous', [], {
      networkPolicy: { networkAccess: true, allowedHosts: ['api.example.com', '*.internal.dev'] },
    });
    expect(engine.check({
      toolName: 'web_fetch',
      input: { url: 'https://api.example.com/v1/data' },
      riskLevel: 'medium',
    })).toBe('allow');
  });

  it('denies web_fetch to non-matching host', () => {
    const engine = new PermissionEngine('autonomous', [], {
      networkPolicy: { networkAccess: true, allowedHosts: ['api.example.com'] },
    });
    expect(engine.check({
      toolName: 'web_fetch',
      input: { url: 'https://evil.com/steal' },
      riskLevel: 'medium',
    })).toBe('deny');
  });

  it('matches wildcard host patterns', () => {
    const engine = new PermissionEngine('autonomous', [], {
      networkPolicy: { networkAccess: true, allowedHosts: ['*.example.com'] },
    });
    // Subdomain matches
    expect(engine.check({
      toolName: 'web_fetch',
      input: { url: 'https://sub.example.com/path' },
      riskLevel: 'medium',
    })).toBe('allow');
    // Bare domain matches *.example.com too
    expect(engine.check({
      toolName: 'web_fetch',
      input: { url: 'https://example.com/path' },
      riskLevel: 'medium',
    })).toBe('allow');
    // Non-matching domain
    expect(engine.check({
      toolName: 'web_fetch',
      input: { url: 'https://notexample.com/path' },
      riskLevel: 'medium',
    })).toBe('deny');
  });

  it('denies web_fetch with malformed URL', () => {
    const engine = new PermissionEngine('autonomous', [], {
      networkPolicy: { networkAccess: true, allowedHosts: ['example.com'] },
    });
    expect(engine.check({
      toolName: 'web_fetch',
      input: { url: 'not-a-url' },
      riskLevel: 'medium',
    })).toBe('deny');
  });

  it('does not apply network policy to non-network tools', () => {
    const engine = new PermissionEngine('autonomous', [], {
      networkPolicy: { networkAccess: false, allowedHosts: [] },
    });
    // Non-network tools should not be affected
    expect(engine.check({
      toolName: 'read',
      input: { file_path: '/etc/passwd' },
      riskLevel: 'low',
    })).toBe('allow');
    expect(engine.check({
      toolName: 'bash',
      input: { command: 'curl evil.com' },
      riskLevel: 'high',
    })).toBe('allow');
  });

  it('applies network policy to web_search too', () => {
    const engine = new PermissionEngine('autonomous', [], {
      networkPolicy: { networkAccess: false, allowedHosts: [] },
    });
    expect(engine.check({
      toolName: 'web_search',
      input: { url: 'https://google.com' },
      riskLevel: 'medium',
    })).toBe('deny');
  });
});
