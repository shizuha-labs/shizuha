// SCLI-583 regression: `shizuha antigravity-bridge --thinking ''` must reject
// locally with the allowed-value diagnostic BEFORE any bridge/runtime/auth/
// config/workspace side effect — an explicit empty required selector must never
// cross the preflight boundary and start a trust-sensitive long-lived process.
//
// Zen's exact-current QA (installed public 0.1.0, artifact ec310f2b09dd):
// `--thinking ''` performed full bridge startup, wrote auth/config/workspace
// state, launched the downstream runtime, and stayed live past a 5 s timeout —
// while `--thinking maybe`, whitespace, invalid effort, unknown option, and
// surplus operand all rejected exit 1 in ~0.8 s. The shared required-value
// preflight (SCLI-492 / PLAT-5893) closes the explicit-empty class; this suite
// pins the antigravity-bridge entrypoint specifically and asserts the
// no-side-effect contract for every rejected value.
//
// Requires the node bundle (dist/shizuha.js); CI builds it before the suite.
import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const CLI = path.join(ROOT, 'dist', 'shizuha.js');

function runBridge(home: string, args: string[]) {
  return spawnSync('node', [CLI, 'antigravity-bridge', ...args], {
    cwd: ROOT,
    env: { ...process.env, HOME: home, FORCE_COLOR: '0' },
    encoding: 'utf8',
    timeout: 15000,
  });
}

// Every trust-sensitive path the bridge would write on a successful startup.
// Rejected values must leave NONE of these behind in the isolated HOME. The
// global logger bootstrap (~/.config/shizuha/logs) is created for EVERY CLI
// invocation (src/utils/logger.ts) and is not bridge state — it is asserted
// separately below as the ONLY permitted mutation.
const SIDE_EFFECT_DIRS = [
  '.shizuha',
  '.gemini',
  '.antigravity',
];

describe('antigravity-bridge --thinking preflight (SCLI-583)', () => {
  beforeAll(() => {
    if (!fs.existsSync(CLI)) {
      throw new Error(
        `node bundle missing at ${CLI}; run 'npm run build:node' (CI does this before the suite)`,
      );
    }
  });

  it('rejects explicit-empty/whitespace/control/unknown thinking before any side effect', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'scli583-bridge-'));
    const before = new Set(fs.readdirSync(home));
    try {
      const cases: Array<[string, string[]]> = [
        ['empty selector', ['--thinking', '']],
        ['whitespace-only', ['--thinking', '   ']],
        ['tab/newline control', ['--thinking', '\t\n']],
        ['unknown value', ['--thinking', 'maybe']],
        ['invalid effort', ['--effort', 'bogus']],
      ];
      for (const [label, args] of cases) {
        const r = runBridge(home, args);
        // Must reject nonzero (and NOT hang — a live bridge would trip the
        // 15 s spawn timeout and yield status null).
        expect(r.status, `status for ${label}`).toBe(1);
        // Bounded allowed-value diagnostic naming the field — no raw stack.
        expect(r.stderr, `stderr for ${label}`).toMatch(/Invalid --(thinking|effort)/);
        expect(r.stderr).not.toMatch(/at |node:internal|\/dist\/|TypeError|ERR_/i);
        // Must NOT reach bridge startup / auth / MCP / listener.
        expect(r.stdout + r.stderr).not.toMatch(
          /antigravity-bridge\]|MCP config written|Agent token|listening|bridge started/i,
        );
      }
      // No trust-sensitive HOME mutation for any rejected case.
      for (const dir of SIDE_EFFECT_DIRS) {
        expect(
          fs.existsSync(path.join(home, dir)),
          `rejected case must not create ${dir}`,
        ).toBe(false);
      }
      // The ONLY permitted mutation is the global logger bootstrap dir
      // (~/.config/shizuha/logs), which every CLI invocation creates.
      const after = new Set(fs.readdirSync(home));
      const created = [...after].filter((f) => !before.has(f));
      for (const entry of created) {
        expect(entry, `unexpected HOME mutation ${entry}`).toBe('.config');
      }
      if (created.includes('.config')) {
        const configEntries = fs.readdirSync(path.join(home, '.config'));
        expect(configEntries).toEqual(['shizuha']);
        const shizuhaEntries = fs.readdirSync(path.join(home, '.config', 'shizuha'));
        expect(shizuhaEntries).toEqual(['logs']);
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('accepts documented on/off values (no preflight rejection)', async () => {
    // `on`/`off` are valid — preflight must NOT reject them. In CI the bridge
    // may still exit nonzero afterwards for environmental reasons (no broker
    // token sidecar / no cluster), so the assertion is on the ABSENCE of the
    // preflight diagnostic, never on the process staying alive. Spawn in a
    // detached group so we can kill any surviving child runtime.
    for (const value of ['on', 'off']) {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'scli583-bridge-ok-'));
      const child = spawn('node', [CLI, 'antigravity-bridge', '--thinking', value], {
        cwd: ROOT,
        env: { ...process.env, HOME: home, FORCE_COLOR: '0' },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      });
      let stderr = '';
      child.stderr.on('data', (d) => (stderr += String(d)));
      try {
        await new Promise((resolve) => setTimeout(resolve, 2500));
        // Preflight must not have rejected the valid value.
        expect(stderr, `stderr for --thinking ${value}`).not.toMatch(/Invalid --thinking/);
        expect(stderr, `stderr for --thinking ${value}`).not.toMatch(/expected one of: off, on, low, medium, high/);
      } finally {
        // Kill the whole process group (children included) and wait for exit.
        try {
          process.kill(-child.pid!, 'SIGKILL');
        } catch {
          /* already gone */
        }
        await new Promise((resolve) => {
          if (child.exitCode !== null) return resolve(undefined);
          child.once('exit', () => resolve(undefined));
          setTimeout(resolve, 2000);
        });
        fs.rmSync(home, { recursive: true, force: true });
      }
    }
  });
});
