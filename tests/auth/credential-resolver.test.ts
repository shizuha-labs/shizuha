import { afterEach, describe, expect, it, vi } from 'vitest';
const { readFileSyncMock } = vi.hoisted(() => ({ readFileSyncMock: vi.fn() }));
vi.mock('node:fs', () => ({ readFileSync: readFileSyncMock }));
import { readAgentCredential } from '../../src/auth/credential-resolver.js';

describe('PLAT-4146 credential resolver', () => {
  afterEach(() => { readFileSyncMock.mockReset(); delete process.env.AGENT_PASSWORD; });

  it('reads allowed credential bytes without trimming', () => {
    readFileSyncMock.mockReturnValue('  exact secret\n');
    expect(readAgentCredential('AGENT_PASSWORD')).toBe('  exact secret\n');
  });

  it.each(['../../etc/hostname', 'AGENT_PASSWORD/../../x', 'OTHER', 'A\\B', 'A\0B'])(
    'rejects unsupported or escaping key %j', (key) => expect(() => readAgentCredential(key)).toThrow(),
  );

  it('falls back to env when the projected file is absent', () => {
    readFileSyncMock.mockImplementation(() => { throw new Error('ENOENT'); });
    process.env.AGENT_PASSWORD = 'env-secret';
    expect(readAgentCredential('AGENT_PASSWORD')).toBe('env-secret');
  });

  it('re-reads the path so an atomic symlink swap is observed', () => {
    readFileSyncMock.mockReturnValueOnce('old').mockReturnValueOnce('new');
    expect(readAgentCredential('AGENT_PASSWORD')).toBe('old');
    expect(readAgentCredential('AGENT_PASSWORD')).toBe('new');
  });
});
