import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');
const cases = [
  { name: 'root help', args: ['--help'], status: 0, output: 'Usage: shizuha' },
  { name: 'serve help', args: ['serve', '--help'], status: 0, output: 'Start the HTTP API server' },
  { name: 'exec help', args: ['exec', '--help'], status: 0, output: 'Execute a prompt' },
  { name: 'version', args: ['--version'], status: 0, output: /\d+\.\d+\.\d+/ },
  { name: 'unknown option', args: ['--unknown-option'], status: 1, output: "unknown option '--unknown-option'" },
  { name: 'missing value', args: ['--mode'], status: 1, output: "option '--mode <mode>' argument missing" },
  { name: 'invalid mode before help', args: ['--mode', 'invalid', '--help'], status: 1, output: 'Invalid --mode' },
  { name: 'invalid mode after help', args: ['--help', '--mode', 'invalid'], status: 1, output: 'Invalid --mode' },
  { name: 'blank mode with help', args: ['--mode=', '--help'], status: 1, output: 'Invalid --mode' },
];

// Observe the actual entrypoint, preserving process.exit's original behavior.
// The old catch deterministically records forced-exit; this is a teardown
// contract test, not a synthetic reproduction of Node's intermittent GC race.
const observer = String.raw`
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const os = require('node:os');
const record = (event) => fs.appendFileSync(process.env.CLI_EXIT_RECEIPT, JSON.stringify(event) + '\n');
const originalExit = process.exit;
process.exit = function(code) {
  record({ event: 'forced-exit', code });
  return originalExit.call(process, code);
};
process.on('beforeExit', (code) => record({ event: 'before-exit', code, resources: process.getActiveResourcesInfo() }));
const loaderPipePath = path.join(os.tmpdir(), 'tsx-' + (process.geteuid ? process.geteuid() : os.userInfo().username), process.ppid + '.pipe');
const loaderPipe = process.platform === 'win32' ? '\\\\?\\pipe\\' + loaderPipePath : loaderPipePath;
for (const [target, method] of [[net.Server.prototype, 'listen'], [net.Socket.prototype, 'connect']]) {
  const original = target[method];
  target[method] = function(...args) {
    const options = Array.isArray(args[0]) ? args[0][0] : args[0];
    const socketPath = typeof options === 'string' ? options : options?.path;
    // tsx connects to its own local parent's IPC pipe during loader import.
    // Preserve that mechanism; a broker socket or TCP connection still fails.
    if (method === 'connect' && socketPath === loaderPipe) return original.apply(this, args);
    record({ event: 'unexpected-network', method });
    throw new Error('Help/parse rejection must not open network handles');
  };
}
const originalFetch = globalThis.fetch;
globalThis.fetch = async function(input, ...args) {
  // Yoga loads its bundled WASM via a data URI, with no network request.
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url;
  if (url?.startsWith('data:')) return originalFetch.call(this, input, ...args);
  record({ event: 'unexpected-network', method: 'fetch' });
  throw new Error('Help/parse rejection must not issue requests');
};
`;

describe.each(['source', 'bundle'] as const)('Commander parse exits (%s)', (entrypoint) => {
  it.each(cases)('$name drains normally without starting an action', ({ args, status, output }) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'shizuha-parse-exit-'));
    const home = path.join(dir, 'home');
    const preload = path.join(dir, 'observe.cjs');
    const receipt = path.join(dir, 'events.jsonl');
    mkdirSync(home);
    writeFileSync(preload, observer);
    try {
      const entry = entrypoint === 'source'
        ? ['--import', 'tsx', path.join(root, 'src/index.ts')]
        : [path.join(root, 'dist/shizuha.js')];
      const result = spawnSync(process.execPath, ['--require', preload, ...entry, ...args], {
        cwd: root,
        env: {
          PATH: process.env.PATH,
          HOME: home,
          TMPDIR: dir,
          CI: 'true',
          NO_COLOR: '1',
          SHIZUHA_DISABLE_TELEMETRY: '1',
          SHIZUHA_DISABLE_MCP_JSON: '1',
          CLI_EXIT_RECEIPT: receipt,
        },
        encoding: 'utf8',
        timeout: 20000,
        killSignal: 'SIGKILL',
      });
      expect(result.error, result.stderr).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(result.status, result.stderr).toBe(status);
      expect(result.stdout + result.stderr).toMatch(output);
      const events = readFileSync(receipt, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      expect(events.filter((event) => event.event === 'forced-exit')).toEqual([]);
      expect(events.filter((event) => event.event === 'unexpected-network')).toEqual([]);
      const drained = events.filter((event) => event.event === 'before-exit');
      expect(drained.length).toBeGreaterThan(0);
      expect(drained.every((event) => event.code === status)).toBe(true);
      // Standard output/error may retain their PipeWrap while their buffered
      // writes drain. No agent timer, listener, socket, or worker may stay alive.
      expect(drained.at(-1).resources.filter((name: string) => !['PipeWrap', 'TTYWrap'].includes(name))).toEqual([]);
      expect(readdirSync(home)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
