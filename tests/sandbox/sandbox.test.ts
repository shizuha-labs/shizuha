import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SandboxConfig } from '../../src/sandbox/types.js';

// Mock os.platform() before importing modules
const mockPlatform = vi.fn<() => NodeJS.Platform>().mockReturnValue('linux');
vi.mock('node:os', () => ({
  platform: () => mockPlatform(),
}));

// Mock execFileSync for bwrap check
const mockExecFileSync = vi.fn();
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    execFileSync: (...args: any[]) => mockExecFileSync(...args),
  };
});

describe('Linux Sandbox (bubblewrap)', () => {
  beforeEach(() => {
    vi.resetModules();
    mockPlatform.mockReturnValue('linux');
    mockExecFileSync.mockReturnValue(Buffer.from(''));
  });

  it('builds read-only sandbox args', async () => {
    const { buildLinuxSandbox } = await import('../../src/sandbox/linux.js');

    const config: SandboxConfig = { mode: 'read-only' };
    const result = buildLinuxSandbox('echo hello', '/home/user/project', config, { PATH: '/usr/bin', TERM: 'dumb' });

    expect(result.command).toBe('bwrap');
    expect(result.args).toContain('--ro-bind');
    expect(result.args).toContain('--unshare-pid');
    expect(result.args).toContain('--unshare-net');
    expect(result.args).toContain('--die-with-parent');
    expect(result.args).toContain('--new-session');
    // Should contain the inner command
    expect(result.args).toContain('bash');
    expect(result.args).toContain('-c');
    expect(result.args).toContain('echo hello');
  });

  it('builds workspace-write sandbox with writable cwd', async () => {
    const { buildLinuxSandbox } = await import('../../src/sandbox/linux.js');

    const config: SandboxConfig = {
      mode: 'workspace-write',
      networkAccess: false,
    };
    const result = buildLinuxSandbox('npm test', '/home/user/project', config, { PATH: '/usr/bin', TERM: 'dumb' });

    expect(result.command).toBe('bwrap');
    // Read-only root
    expect(result.args.includes('--ro-bind')).toBe(true);
    // Writable cwd
    const bindIdx = result.args.indexOf('--bind');
    expect(bindIdx).toBeGreaterThan(-1);
    expect(result.args[bindIdx + 1]).toContain('/home/user/project');
    // Network blocked
    expect(result.args).toContain('--unshare-net');
  });

  it('allows network access when configured', async () => {
    const { buildLinuxSandbox } = await import('../../src/sandbox/linux.js');

    const config: SandboxConfig = {
      mode: 'workspace-write',
      networkAccess: true,
    };
    const result = buildLinuxSandbox('curl example.com', '/tmp/test', config, { TERM: 'dumb' });

    // Should NOT have --unshare-net when network is allowed
    expect(result.args).not.toContain('--unshare-net');
  });

  it('includes additional writable paths', async () => {
    const { buildLinuxSandbox } = await import('../../src/sandbox/linux.js');

    const config: SandboxConfig = {
      mode: 'workspace-write',
      writablePaths: ['/var/data', '/opt/cache'],
    };
    const result = buildLinuxSandbox('echo test', '/home/user/project', config, { TERM: 'dumb' });

    // Should have --bind for each writable path
    const bindArgs = result.args.filter((a, i) => result.args[i - 1] === '--bind');
    expect(bindArgs).toContain('/var/data');
    expect(bindArgs).toContain('/opt/cache');
  });

  it('protects .git within writable roots', async () => {
    const { buildLinuxSandbox } = await import('../../src/sandbox/linux.js');

    const config: SandboxConfig = { mode: 'workspace-write' };
    const result = buildLinuxSandbox('echo test', '/home/user/project', config, { TERM: 'dumb' });

    // Should have --ro-bind-try for .git
    const roBindTryIdx = result.args.indexOf('--ro-bind-try');
    expect(roBindTryIdx).toBeGreaterThan(-1);
    expect(result.args[roBindTryIdx + 1]).toContain('.git');
  });
});

describe('macOS Sandbox (Seatbelt)', () => {
  it('generates read-only seatbelt profile', async () => {
    const { _generateSeatbeltProfile } = await import('../../src/sandbox/macos.js');

    const config: SandboxConfig = { mode: 'read-only' };
    const profile = _generateSeatbeltProfile('/Users/dev/project', config);

    expect(profile).toContain('(version 1)');
    expect(profile).toContain('(deny default)');
    expect(profile).toContain('(allow file-read*)');
    expect(profile).toContain('(deny file-write*)');
    expect(profile).toContain('(deny network*)');
  });

  it('generates workspace-write seatbelt profile with cwd writable', async () => {
    const { _generateSeatbeltProfile } = await import('../../src/sandbox/macos.js');

    const config: SandboxConfig = {
      mode: 'workspace-write',
      networkAccess: false,
    };
    const profile = _generateSeatbeltProfile('/Users/dev/project', config);

    expect(profile).toContain('(version 1)');
    expect(profile).toContain('(allow file-read*)');
    // Writable workspace
    expect(profile).toContain('(allow file-write* (subpath "/Users/dev/project"))');
    // Writable /tmp
    expect(profile).toContain('(allow file-write* (subpath "/tmp"))');
    // Network blocked
    expect(profile).toContain('(deny network-outbound)');
  });

  it('allows network when configured', async () => {
    const { _generateSeatbeltProfile } = await import('../../src/sandbox/macos.js');

    const config: SandboxConfig = {
      mode: 'workspace-write',
      networkAccess: true,
    };
    const profile = _generateSeatbeltProfile('/Users/dev/project', config);

    expect(profile).toContain('(allow network*)');
    expect(profile).not.toContain('(deny network-outbound)');
  });

  it('protects .git from writes', async () => {
    const { _generateSeatbeltProfile } = await import('../../src/sandbox/macos.js');

    const config: SandboxConfig = { mode: 'workspace-write' };
    const profile = _generateSeatbeltProfile('/Users/dev/project', config);

    expect(profile).toContain('(deny file-write* (subpath "/Users/dev/project/.git"))');
  });

  it('builds sandbox-exec spawn options', async () => {
    const { buildMacOSSandbox } = await import('../../src/sandbox/macos.js');

    const config: SandboxConfig = { mode: 'workspace-write' };
    const result = buildMacOSSandbox('echo hello', '/Users/dev/project', config, { TERM: 'dumb' });

    expect(result.command).toBe('sandbox-exec');
    expect(result.args[0]).toBe('-p');
    expect(result.args[1]).toContain('(version 1)');
    expect(result.args[2]).toBe('bash');
    expect(result.args[3]).toBe('-c');
    expect(result.args[4]).toBe('echo hello');
  });
});

describe('Unified Sandbox API', () => {
  beforeEach(() => {
    vi.resetModules();
    mockExecFileSync.mockReturnValue(Buffer.from(''));
  });

  it('returns null for unrestricted mode', async () => {
    mockPlatform.mockReturnValue('linux');
    const { buildSandboxedSpawn } = await import('../../src/sandbox/index.js');

    const config: SandboxConfig = { mode: 'unrestricted' };
    const result = buildSandboxedSpawn('echo test', '/tmp', config, { TERM: 'dumb' });

    expect(result).toBeNull();
  });

  it('returns null for external mode', async () => {
    mockPlatform.mockReturnValue('linux');
    const { buildSandboxedSpawn } = await import('../../src/sandbox/index.js');

    const config: SandboxConfig = { mode: 'external' };
    const result = buildSandboxedSpawn('echo test', '/tmp', config, { TERM: 'dumb' });

    expect(result).toBeNull();
  });

  it('describes sandbox configuration', async () => {
    mockPlatform.mockReturnValue('linux');
    const { describeSandbox } = await import('../../src/sandbox/index.js');

    expect(describeSandbox({ mode: 'unrestricted' })).toBe('No sandbox');
    expect(describeSandbox({ mode: 'external' })).toBe('External sandbox (Docker)');
    expect(describeSandbox({ mode: 'read-only' })).toContain('read-only');
    expect(describeSandbox({ mode: 'workspace-write', networkAccess: true })).toContain('network: allowed');
    expect(describeSandbox({ mode: 'workspace-write', networkAccess: false })).toContain('network: blocked');
  });
});

describe('Config Schema', () => {
  it('parses sandbox config with defaults', async () => {
    const { sandboxSchema } = await import('../../src/config/schema.js');

    const result = sandboxSchema.parse({});
    expect(result.mode).toBe('unrestricted');
    expect(result.writablePaths).toEqual([]);
    expect(result.networkAccess).toBe(false);
    expect(result.protectedPaths).toContain('.git');
  });

  it('parses workspace-write with custom paths', async () => {
    const { sandboxSchema } = await import('../../src/config/schema.js');

    const result = sandboxSchema.parse({
      mode: 'workspace-write',
      writablePaths: ['/var/data'],
      networkAccess: true,
    });
    expect(result.mode).toBe('workspace-write');
    expect(result.writablePaths).toEqual(['/var/data']);
    expect(result.networkAccess).toBe(true);
  });

  it('includes sandbox in full config schema', async () => {
    const { configSchema } = await import('../../src/config/schema.js');

    const result = configSchema.parse({});
    expect(result.sandbox).toBeDefined();
    expect(result.sandbox.mode).toBe('unrestricted');
  });
});
