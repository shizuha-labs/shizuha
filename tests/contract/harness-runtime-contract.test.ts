/**
 * Outward-migration tripwire (Phase 0).
 *
 * Hive agent pods and the human TUI share this repo's `dist/shizuha.js`.
 * Extracting daemon/bench must not delete the commands or method→command
 * mapping the live fleet depends on. These assertions read source, not a
 * built bundle, so they stay valid while we split packages.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  runtimeCommandForExecutionMethod,
  RUNTIME_LANE_EXECUTION_METHODS,
} from '../../src/daemon/runtime-lane-methods.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const REQUIRED_COMMANDS = [
  'exec',
  'resume',
  'gateway',
  'claude-bridge',
  'codex-bridge',
  'antigravity-bridge',
  'openclaw-bridge',
  'up',
  'plugins',
] as const;

function read(rel: string): string {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

function parseEntrypointMethodTable(src: string): Record<string, string> {
  const match = src.match(/const byMethod = \{([\s\S]*?)\};/);
  expect(match, 'agent-runtime-entrypoint.sh must contain a byMethod table').toBeTruthy();
  const body = match![1];
  const table: Record<string, string> = {};
  const pair = /([A-Za-z0-9_]+)\s*:\s*"([a-z0-9-]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = pair.exec(body)) !== null) {
    table[m[1]] = m[2];
  }
  return table;
}

describe('harness/runtime compatibility contract', () => {
  it('keeps the TUI + fleet CLI commands registered in src/index.ts', () => {
    const index = read('src/index.ts');
    expect(index).toContain("from './tui/App.js'");
    expect(index).toMatch(/launchTUI\(/);
    for (const command of REQUIRED_COMMANDS) {
      expect(index, `missing commander command ${command}`).toMatch(
        new RegExp(`\\.command\\('${command}(?:\\s|')`),
      );
    }
  });

  it('keeps the fleet k8s actuator behind a default-off plugin', () => {
    expect(fs.existsSync(path.join(root, 'src/plugins/fleet/k8s-backend.ts'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'src/plugins/fleet/k8s-backend.stub.ts'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'src/plugins/profile.ts'))).toBe(true);
    const loader = read('src/daemon/k8s-backend.ts');
    expect(loader).toMatch(/from '\.\.\/plugins\/fleet\/k8s-backend\.js'/);
    expect(loader).not.toMatch(/SHIZUHA_FLEET_NAMESPACE/);
    const stub = read('src/plugins/fleet/k8s-backend.stub.ts');
    expect(stub).toMatch(/isK8sAgent/);
    expect(stub).toMatch(/return false/);
    expect(stub).not.toMatch(/SHIZUHA_FLEET_NAMESPACE/);
    const impl = read('src/plugins/fleet/k8s-backend.ts');
    expect(impl).toMatch(/SHIZUHA_FLEET_NAMESPACE/);
    expect(impl).toMatch(/isBuiltinPluginEnabled\('fleet\/k8s'\)/);
    const profile = read('src/plugins/profile.ts');
    expect(profile).toMatch(/PROFILE_IDS = \['default', 'fleet'\]/);
    expect(profile).toMatch(/id: 'fleet\/k8s'/);
    const index = read('src/index.ts');
    expect(index).toMatch(/\.command\('plugins'/);
    const pkg = read('package.json');
    expect(pkg).toMatch(/"build:public":/);
    expect(pkg).toMatch(/--no-fleet-plugin/);
    expect(pkg).toMatch(/vite build --config vite\.web\.config\.ts/);
  });

  it('keeps the local daemon dashboard so users can chat in the browser', () => {
    expect(fs.existsSync(path.join(root, 'src/daemon/dashboard.ts'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'src/web/App.tsx'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'src/web/components/ChatView.tsx'))).toBe(true);
    expect(read('src/daemon/dashboard.ts')).toMatch(/export async function startDashboard/);
    expect(read('src/index.ts')).toMatch(/\.command\('up'/);
  });

  it('keeps the agent-runtime image contract files', () => {
    for (const rel of [
      'Dockerfile.agent-runtime',
      'agent-runtime-entrypoint.sh',
      'src/daemon/runtime-lane-methods.ts',
      'src/shared/heartbeat-outcome.ts',
      'src/shared/event-log.ts',
      'src/shared/init-system.ts',
      'src/shared/is-daemon-running.ts',
    ]) {
      expect(fs.existsSync(path.join(root, rel)), rel).toBe(true);
    }
    expect(read('Dockerfile.agent-runtime')).toMatch(/agent-runtime-entrypoint\.sh/);
    expect(read('src/daemon/heartbeat-outcome.ts')).toMatch(/from '\.\.\/shared\/heartbeat-outcome\.js'/);
    expect(read('src/daemon/event-log.ts')).toMatch(/from '\.\.\/shared\/event-log\.js'/);
  });

  it('does not let the harness process import heartbeat-outcome/event-log through daemon/', () => {
    const harnessFiles = [
      'src/gateway/agent-process.ts',
      'src/gateway/channels/shizuha-ws.ts',
      'src/gateway/types.ts',
      'src/claude-bridge/index.ts',
      'src/codex-bridge/index.ts',
      'src/antigravity-bridge/index.ts',
      'src/commands/update.ts',
      'src/tui/auto-update.ts',
      'src/prompt/bridge-identity.ts',
    ];
    for (const rel of harnessFiles) {
      const text = read(rel);
      expect(text, rel).not.toMatch(/from ['\"]\.\.\/daemon\/heartbeat-outcome/);
      expect(text, rel).not.toMatch(/from ['\"]\.\.\/daemon\/event-log/);
      expect(text, rel).not.toMatch(/from ['\"]\.\.\/daemon\/service/);
      expect(text, rel).not.toMatch(/from ['\"]\.\.\/daemon\/state/);
      expect(text, rel).not.toMatch(/from ['\"]\.\.\/daemon\/types/);
    }
  });

  it('maps every canonical Hive execution_method to the same CLI command in TS and the entrypoint', () => {
    const entry = parseEntrypointMethodTable(read('agent-runtime-entrypoint.sh'));
    const expected: Record<string, string> = {
      shizuha: 'gateway',
      grok_build: 'gateway',
      claude_code_server: 'claude-bridge',
      codex_app_server: 'codex-bridge',
      antigravity_server: 'antigravity-bridge',
      openclaw_app_server: 'openclaw-bridge',
    };
    for (const [method, command] of Object.entries(expected)) {
      expect(runtimeCommandForExecutionMethod(method), `TS map for ${method}`).toBe(command);
      expect(
        entry[method],
        `entrypoint byMethod missing ${method}→${command} (pods fall back to this script)`,
      ).toBe(command);
    }
    for (const [method, spec] of Object.entries(RUNTIME_LANE_EXECUTION_METHODS)) {
      expect(runtimeCommandForExecutionMethod(method)).toBe(spec.command);
    }
  });
});
