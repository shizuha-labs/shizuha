/**
 * SCLI-518 — browser-mcp JSON-RPC/MCP admission contract at the public stdio
 * boundary. The installed artifact accepted or silently dropped malformed
 * protocol input instead of enforcing the JSON-RPC/MCP handshake:
 *   - malformed JSON / scalar / null produced no JSON-RPC error (null threw an
 *     uncaughtException because `msg.method` dereferenced null)
 *   - jsonrpc:"1.0" and initialize-with-no-params got success-shaped results
 *   - tools/list succeeded before any initialize handshake
 *   - an unsupported protocol version (1900-01-01) was echoed as supported
 *
 * These tests drive the BUILT CLI (dist/shizuha.js) `browser-mcp` command and
 * assert the standards-shaped admission contract. Requires the node bundle.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as readline from 'node:readline';

const ROOT = path.resolve(import.meta.dirname, '..');
const CLI = path.join(ROOT, 'dist', 'shizuha.js');

interface RpcResponse {
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

/** Spawn browser-mcp, write the given lines, collect responses until close. */
function driveMcp(lines: string[]): Promise<{ responses: RpcResponse[]; stderr: string }> {
  return new Promise((resolve, reject) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'scli518-'));
    const child = spawn('node', [CLI, 'browser-mcp'], {
      cwd: ROOT,
      env: { ...process.env, HOME: home, TERM: 'dumb', NO_COLOR: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const responses: RpcResponse[] = [];
    const stderr: string[] = [];
    const rl = readline.createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        responses.push(JSON.parse(trimmed) as RpcResponse);
      } catch {
        // non-JSON on stdout is a contract violation
        responses.push({ id: null, error: { code: -1, message: `non-JSON stdout: ${trimmed}` } });
      }
    });
    child.stderr.on('data', (d) => stderr.push(String(d)));
    child.on('error', reject);
    child.on('close', () => {
      fs.rmSync(home, { recursive: true, force: true });
      resolve({ responses, stderr: stderr.join('') });
    });
    for (const line of lines) child.stdin.write(line + '\n');
    child.stdin.end();
  });
}

function byId(responses: RpcResponse[], id: string | number | null): RpcResponse | undefined {
  return responses.find((r) => r.id === id);
}

describe('browser-mcp admission contract (SCLI-518)', () => {
  beforeAll(() => {
    if (!fs.existsSync(CLI)) {
      throw new Error(
        `node bundle missing at ${CLI}; run 'npm run build:node' (CI does this before the suite)`,
      );
    }
  });

  it('rejects malformed JSON with a parse error, never a silent drop', async () => {
    const { responses } = await driveMcp(['{bad json']);
    expect(responses).toHaveLength(1);
    expect(responses[0].error?.code).toBe(-32700);
    expect(responses[0].id).toBeNull();
  });

  it('rejects null / scalar / array input with invalid-request, no uncaughtException', async () => {
    const { responses, stderr } = await driveMcp(['null', '42', '[1,2]']);
    expect(responses).toHaveLength(3);
    for (const r of responses) {
      expect(r.error?.code).toBe(-32600);
      expect(r.id).toBeNull();
    }
    // null previously threw an uncaughtException (kept alive) — must not now.
    expect(stderr).not.toMatch(/uncaughtException|unhandledRejection/);
  });

  it('rejects jsonrpc:"1.0" with invalid-request', async () => {
    const { responses } = await driveMcp([
      '{"jsonrpc":"1.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}',
    ]);
    const r = byId(responses, 1);
    expect(r?.error?.code).toBe(-32600);
    expect(r?.error?.message).toContain('jsonrpc must be "2.0"');
  });

  it('rejects initialize with missing/invalid protocolVersion params', async () => {
    const { responses } = await driveMcp([
      '{"jsonrpc":"2.0","id":2,"method":"initialize"}',
      '{"jsonrpc":"2.0","id":3,"method":"initialize","params":{"protocolVersion":123}}',
    ]);
    expect(byId(responses, 2)?.error?.code).toBe(-32602);
    expect(byId(responses, 3)?.error?.code).toBe(-32602);
  });

  it('rejects tools/list and tools/call before initialize', async () => {
    const { responses } = await driveMcp([
      '{"jsonrpc":"2.0","id":4,"method":"tools/list"}',
      '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"browser","arguments":{}}}',
    ]);
    expect(byId(responses, 4)?.error?.code).toBe(-32002);
    expect(byId(responses, 5)?.error?.code).toBe(-32002);
    expect(byId(responses, 4)?.error?.message).toContain('not initialized');
  });

  it('never echoes an unsupported protocol version as supported', async () => {
    const { responses } = await driveMcp([
      '{"jsonrpc":"2.0","id":6,"method":"initialize","params":{"protocolVersion":"1900-01-01"}}',
    ]);
    const r = byId(responses, 6);
    const result = r?.result as { protocolVersion?: string } | undefined;
    // Negotiated to the server's supported version, never the client's bogus one.
    expect(result?.protocolVersion).toBe('2025-06-18');
  });

  it('valid handshake exposes exactly browser, mouse, keyboard', async () => {
    const { responses } = await driveMcp([
      '{"jsonrpc":"2.0","id":7,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}',
      '{"jsonrpc":"2.0","method":"notifications/initialized"}',
      '{"jsonrpc":"2.0","id":8,"method":"tools/list"}',
    ]);
    const init = byId(responses, 7);
    expect(init?.error).toBeUndefined();
    const tools = (byId(responses, 8)?.result as { tools?: { name: string }[] })?.tools ?? [];
    expect(tools.map((t) => t.name).sort()).toEqual(['browser', 'keyboard', 'mouse']);
  });
});
