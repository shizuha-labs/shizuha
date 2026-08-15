import { afterEach, describe, expect, it } from 'vitest';
import {
  composePluginTree,
  formatPluginTree,
  isBuiltinPluginEnabled,
  resolveProfile,
} from '../../src/plugins/profile.js';
import { isK8sAgent } from '../../src/daemon/k8s-backend.js';

const touched = [
  'SHIZUHA_PROFILE',
  'SHIZUHA_DAEMON_RUNTIME',
  'SHIZUHA_RUNTIME_BACKEND',
  'SHIZUHA_FLEET_NAMESPACE',
] as const;

function setEnv(env: Record<string, string | undefined>): void {
  for (const key of touched) {
    if (key in env) {
      const value = env[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

afterEach(() => {
  for (const key of touched) delete process.env[key];
});

describe('plugin profiles', () => {
  it('defaults to TUI + dashboard + harness with no k8s actuator row', () => {
    const resolved = resolveProfile({
      SHIZUHA_PROFILE: undefined,
      SHIZUHA_DAEMON_RUNTIME: undefined,
      SHIZUHA_RUNTIME_BACKEND: undefined,
      SHIZUHA_FLEET_NAMESPACE: undefined,
    });
    expect(resolved).toEqual({ profile: 'default', source: 'default' });
    expect(isBuiltinPluginEnabled('fleet/k8s', resolvedEnv())).toBe(false);
    expect(isBuiltinPluginEnabled('dashboard', resolvedEnv())).toBe(true);
    expect(isBuiltinPluginEnabled('tui', resolvedEnv())).toBe(true);
    const tree = composePluginTree(resolvedEnv());
    expect(tree.mounted.map((row) => row.id)).toEqual(['tui', 'dashboard', 'harness']);
    expect(tree.available.map((row) => row.id)).toEqual([]);
    expect(formatPluginTree(tree)).toContain('profile: default');
    expect(formatPluginTree(tree)).not.toContain('fleet/k8s');
  });

  it('still recognizes SHIZUHA_PROFILE=fleet but does not mount a k8s writer', () => {
    expect(resolveProfile({ SHIZUHA_PROFILE: 'fleet' }).profile).toBe('fleet');
    expect(isBuiltinPluginEnabled('fleet/k8s', { SHIZUHA_PROFILE: 'fleet' })).toBe(false);
    expect(
      composePluginTree({ SHIZUHA_PROFILE: 'fleet' }).mounted.map((row) => row.id),
    ).toEqual(['tui', 'dashboard', 'harness']);
  });

  it('selects fleet for a k8s fleet daemon even without SHIZUHA_PROFILE', () => {
    expect(
      resolveProfile({ SHIZUHA_DAEMON_RUNTIME: 'k8s' }),
    ).toEqual({ profile: 'fleet', source: 'k8s-daemon' });
    expect(
      resolveProfile({ SHIZUHA_FLEET_NAMESPACE: 'shizuha-fleet' }).profile,
    ).toBe('fleet');
  });

  it('lets an explicit default profile win over fleet-daemon env', () => {
    expect(
      resolveProfile({
        SHIZUHA_PROFILE: 'default',
        SHIZUHA_DAEMON_RUNTIME: 'k8s',
      }),
    ).toEqual({ profile: 'default', source: 'env' });
  });

  it('never treats a local agent as a k8s pod', () => {
    setEnv({
      SHIZUHA_PROFILE: 'default',
      SHIZUHA_DAEMON_RUNTIME: undefined,
      SHIZUHA_RUNTIME_BACKEND: undefined,
      SHIZUHA_FLEET_NAMESPACE: undefined,
    });
    expect(isK8sAgent({ id: 'x', username: 'kai', runtimeEnvironment: 'k8s' } as never)).toBe(false);
    setEnv({ SHIZUHA_PROFILE: 'fleet' });
    expect(isK8sAgent({ id: 'x', username: 'kai', runtimeEnvironment: 'k8s' } as never)).toBe(false);
  });
});

function resolvedEnv(): NodeJS.ProcessEnv {
  return {
    SHIZUHA_PROFILE: undefined,
    SHIZUHA_DAEMON_RUNTIME: undefined,
    SHIZUHA_RUNTIME_BACKEND: undefined,
    SHIZUHA_FLEET_NAMESPACE: undefined,
  };
}
