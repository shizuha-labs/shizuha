/**
 * Shared tmux harness for TUI e2e.
 *
 * Isolated `-L` socket per session so vitest workers cannot collide on the
 * default tmux server. No SHIZUHA_RUN_TMUX_* env gate: if tmux is present the
 * suite runs; in CI a missing tmux is a failure, not a skip.
 */
import { execFileSync, execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'vitest';

export const projectDir = path.resolve(import.meta.dirname!, '../../..');

const sockets = new Map<string, string>();

export function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function hasTmux(): boolean {
  try {
    execSync('tmux -V', { stdio: ['ignore', 'pipe', 'pipe'] });
    return true;
  } catch {
    return false;
  }
}

export function tmuxE2eDescribe(name: string, factory: () => void, timeout?: number): void {
  if (hasTmux()) {
    describe(name, factory, timeout);
    return;
  }
  if (process.env['CI'] === 'true') {
    describe(name, () => {
      it('requires tmux in CI — this is not an env-var skip', () => {
        throw new Error(
          'tmux is required for TUI e2e in CI. Install tmux in the test Job/image. Do not reintroduce SHIZUHA_RUN_TMUX_* gates.',
        );
      });
    });
    return;
  }
  describe.skip(name, factory);
}

export function ensureDistBuilt(): void {
  const dist = path.join(projectDir, 'dist', 'shizuha.js');
  if (fs.existsSync(dist)) return;
  execSync('npm run build:node', { cwd: projectDir, stdio: 'inherit' });
}

function sessionNameOf(sessionOrTarget: string): string {
  return sessionOrTarget.split(':')[0]!;
}

/**
 * Env vars that must never leak from the vitest/CI runner into the pane
 * running the system under test (SCLI-723).
 *
 * The fullsuite Job sets CI=true for vitest. Without this scrub the spawned
 * tmux server — and therefore the app's pane — inherits it, and Ink 6's
 * is-in-ci branch suppresses every frame until the app exits: the pane stays
 * empty and every tmux e2e times out on an empty capture. The harness must
 * present the SUT a clean, user-like environment; CI-infra signals stay in
 * the runner process only (tmuxE2eDescribe's fail-closed guard still sees
 * CI=true because it runs in the vitest worker, not the pane).
 */
const PANE_ENV_BLOCKLIST: RegExp[] = [
  /^CI$/,
  /^CONTINUOUS_INTEGRATION$/,
  /^NODE_ENV$/,
  /^VITEST_/,
  /^npm_config_/,
  /^NPM_CONFIG_/,
  /^SHIZUHA_CI_/,
];

export function sanitizedPaneEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (PANE_ENV_BLOCKLIST.some((re) => re.test(key))) continue;
    env[key] = value;
  }
  return env;
}

function socketFor(sessionOrTarget: string): string {
  const session = sessionNameOf(sessionOrTarget);
  const socket = sockets.get(session);
  if (!socket) {
    throw new Error(`no isolated tmux socket registered for ${session}`);
  }
  return socket;
}

function tmux(sessionOrTarget: string, args: string[]): string {
  return execFileSync('tmux', ['-L', socketFor(sessionOrTarget), ...args], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export function launchTmux(
  name: string,
  width: number,
  height: number,
  command: string,
): { session: string; target: string } {
  const session = `${name}_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
  const socket = `scli${process.pid}${session}`.replace(/[^a-zA-Z0-9]/g, '').slice(0, 48);
  const target = `${session}:0.0`;
  sockets.set(session, socket);
  const paneEnv = sanitizedPaneEnv();
  execFileSync('tmux', [
    '-L', socket, 'new-session', '-d', '-x', String(width), '-y', String(height),
    '-s', session, command,
  ], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], env: paneEnv });
  execFileSync('tmux', [
    '-L', socket, 'resize-window', '-t', `${session}:0`,
    '-x', String(width), '-y', String(height),
  ], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], env: paneEnv });
  return { session, target };
}

export function killTmux(session: string): void {
  try {
    tmux(session, ['kill-server']);
  } catch {
    // already gone
  }
  sockets.delete(sessionNameOf(session));
}

/** Visible pane only — what a human is looking at. */
export function captureVisible(target: string): string {
  return tmux(target, ['capture-pane', '-p', '-t', target]);
}

export function capture(target: string, startLine = -320): string {
  return tmux(target, ['capture-pane', '-p', '-t', target, '-S', String(startLine)]);
}

export function captureWithScrollback(target: string, lines = 2000): string {
  return tmux(target, ['capture-pane', '-p', '-t', target, '-S', `-${lines}`]);
}

export function sendKeys(target: string, ...keys: string[]): void {
  const normalized = keys.map((key) => key === 'Enter' ? 'C-m' : key);
  tmux(target, ['send-keys', '-t', target, ...normalized]);
}

export function sendLiteral(target: string, text: string): void {
  tmux(target, ['send-keys', '-t', target, '-l', text]);
}

export function sendWheel(target: string, direction: 'up' | 'down', count = 1): void {
  const seq = direction === 'up' ? '\x1b[<64;20;12M' : '\x1b[<65;20;12M';
  for (let i = 0; i < count; i++) {
    tmux(target, ['send-keys', '-t', target, '-l', seq]);
  }
}

export function paneFlags(target: string): string {
  return tmux(target, [
    'display-message', '-p', '-t', target,
    '#{alternate_on} #{history_size} #{mouse_any_flag}',
  ]).trim();
}

export function historySize(target: string): string {
  return tmux(target, ['display-message', '-p', '-t', target, '#{history_size}']).trim();
}

export function altMouseFlags(target: string): string {
  return tmux(target, [
    'display-message', '-p', '-t', target,
    '#{alternate_on} #{mouse_any_flag}',
  ]).trim();
}

export function resizeWindow(session: string, width: number, height: number): void {
  tmux(session, [
    'resize-window', '-t', `${sessionNameOf(session)}:0`,
    '-x', String(width), '-y', String(height),
  ]);
}

export async function waitForPattern(
  target: string,
  pattern: RegExp,
  timeoutMs: number,
): Promise<string> {
  const started = Date.now();
  let last = '';
  while (Date.now() - started < timeoutMs) {
    last = captureVisible(target);
    if (pattern.test(last)) return last;
    await sleepMs(80);
  }
  throw new Error(`Timeout waiting for ${pattern}. Last capture:\n${last.slice(-2000)}`);
}

export function stageProviderCredentials(tempHome: string): boolean {
  const srcDir = path.join(os.homedir(), '.shizuha');
  const dstDir = path.join(tempHome, '.shizuha');
  const candidates = ['credentials.json', 'auth.json', 'jwt_token', 'config.toml'];
  let copiedAny = false;
  for (const file of candidates) {
    const src = path.join(srcDir, file);
    const dst = path.join(dstDir, file);
    if (fs.existsSync(src)) {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
      copiedAny = true;
    }
  }
  return copiedAny;
}

/** Isolated HOME + no MCP. Local `!` commands work without a live model. */
export function launchShizuha(
  tempHome: string,
  name: string,
  width: number,
  height: number,
  extraEnv = '',
): { session: string; target: string } {
  return launchShizuhaCli({
    tempHome,
    name,
    width,
    height,
    extraEnv,
    args: ['--model', 'test-model'],
  });
}

/** Real `dist/shizuha.js` process in tmux, with caller-controlled args and env. */
export function launchShizuhaCli(opts: {
  tempHome: string;
  name: string;
  width: number;
  height: number;
  args?: string[];
  extraEnv?: string;
  env?: Record<string, string>;
}): { session: string; target: string } {
  const envPairs = Object.entries(opts.env ?? {})
    .map(([key, value]) => `${key}=${shQuote(value)}`)
    .join(' ');
  const launchCommand = [
    `cd ${shQuote(projectDir)}`,
    `&& HOME=${shQuote(opts.tempHome)}`,
    'SHIZUHA_DISABLE_MCP_JSON=1',
    'SHIZUHA_AUTO_UPDATE=0',
    'FORCE_COLOR=0',
    envPairs,
    opts.extraEnv ?? '',
    `node ${shQuote(process.env['SHIZUHA_E2E_CLI'] || path.join(projectDir, 'dist', 'shizuha.js'))}`,
    ...(opts.args ?? []),
  ].filter(Boolean).join(' ');
  return launchTmux(opts.name, opts.width, opts.height, launchCommand);
}

export function uniqueMarker(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}
