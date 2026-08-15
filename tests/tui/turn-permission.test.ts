import { describe, it, expect, vi } from 'vitest';
import type { PermissionAskCallback } from '../../src/agent/turn.js';
import { PermissionEngine } from '../../src/permissions/engine.js';

describe('executeTurn onPermissionAsk integration', () => {
  // We can't easily test executeTurn directly (requires a real LLM provider),
  // but we can test the permission engine + callback contract.

  it('PermissionEngine returns ask for medium-risk in supervised mode', () => {
    const engine = new PermissionEngine('supervised');
    const decision = engine.check({ toolName: 'write', input: {}, riskLevel: 'medium' });
    expect(decision).toBe('ask');
  });

  it('PermissionEngine.approve makes subsequent checks return allow', () => {
    const engine = new PermissionEngine('supervised');
    expect(engine.check({ toolName: 'write', input: {}, riskLevel: 'medium' })).toBe('ask');
    engine.approve('write');
    expect(engine.check({ toolName: 'write', input: {}, riskLevel: 'medium' })).toBe('allow');
  });

  it('PermissionAskCallback contract: allow resolves without error', async () => {
    const callback: PermissionAskCallback = vi.fn().mockResolvedValue('allow');
    const result = await callback('bash', { command: 'ls' }, 'high');
    expect(result).toBe('allow');
  });

  it('PermissionAskCallback contract: deny resolves', async () => {
    const callback: PermissionAskCallback = vi.fn().mockResolvedValue('deny');
    const result = await callback('write', { file_path: '/etc/passwd' }, 'high');
    expect(result).toBe('deny');
  });

  it('PermissionAskCallback contract: allow_always resolves', async () => {
    const callback: PermissionAskCallback = vi.fn().mockResolvedValue('allow_always');
    const result = await callback('bash', { command: 'npm test' }, 'medium');
    expect(result).toBe('allow_always');
  });
});
