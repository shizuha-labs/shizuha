#!/usr/bin/env node
/**
 * BRW-37 positive smoke: a real human-mode navigate + screenshot through the
 * browser MCP server, exercised exactly the way the agent runtime launches it
 * (config.toml `mcp_servers.browser` -> `node dist/shizuha.js browser-mcp`).
 *
 * Requires the harness to be built (`npm run build:node` -> dist/shizuha.js)
 * and a runtime with the pre-provisioned playwright chromium:
 *   PLAYWRIGHT_BROWSERS_PATH=/opt/playwright-browsers
 *   (plus Xvfb so Chrome can run headed — present in the agent-runtime image).
 *
 * Usage:
 *   node scripts/browser-mcp-human-smoke.mjs
 *
 * Exit 0 = contract OK. Non-zero + a loud diagnostic = listener/launch broken
 * (the negative half of BRW-37 AC3 is covered by tests/browser/cdp.test.ts at
 * the readiness gate; this script proves the positive launch/connect half).
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist', 'shizuha.js');

if (!fs.existsSync(DIST)) {
  console.error(`[browser-mcp-human-smoke] dist build missing: ${DIST}. Run \`npm run build:node\` first.`);
  process.exit(2);
}

const server = spawn(process.execPath, [DIST, 'browser-mcp'], {
  env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/playwright-browsers' },
  stdio: ['pipe', 'pipe', 'pipe'],
});

let buf = '';
const calls = new Map();
let idc = 0;
server.stdout.on('data', (d) => {
  buf += d.toString();
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    try {
      const m = JSON.parse(line);
      if (m.id && calls.has(m.id)) {
        const { res, rej } = calls.get(m.id);
        calls.delete(m.id);
        m.error ? rej(m.error) : res(m.result);
      }
    } catch { /* ignore partially-framed lines */ }
  }
});
server.stderr.on('data', (d) => process.stderr.write('SRV| ' + d.toString()));

function call(method, params) {
  return new Promise((res, rej) => {
    const id = ++idc;
    calls.set(id, { res, rej });
    server.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
const text = (r) => { try { return r.content.map((c) => c.type === 'text' ? c.text : '').join(' '); } catch { return JSON.stringify(r); } };
const image = (r) => { try { const c = r.content.find((c) => c.type === 'image'); return c ? c.data : null; } catch { return null; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  let exitCode = 1;
  try {
    await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'brw37-smoke', version: '1.0.0' } });
    const nav = await call('tools/call', { name: 'browser', arguments: { action: 'navigate', mode: 'human', url: 'about:blank' } });
    const navText = text(nav);
    console.log('[browser-mcp-human-smoke] navigate:', navText);
    if (!/Navigated to/.test(navText)) throw new Error('human-mode navigate did not report success: ' + navText);

    const shot = await call('tools/call', { name: 'browser', arguments: { action: 'screenshot', mode: 'human' } });
    const img = image(shot);
    if (!img || img.length < 1024) throw new Error('human-mode screenshot empty/tiny: ' + (img ? img.length : 'none'));
    console.log(`[browser-mcp-human-smoke] screenshot ok (${img.length} b64 chars)`);

    // Persist the screenshot so CI can attach it as typed evidence.
    const out = path.join(ROOT, 'browser-mcp-human-smoke.png');
    fs.writeFileSync(out, Buffer.from(img, 'base64'));
    console.log(`[browser-mcp-human-smoke] screenshot written to ${out}`);

    console.log('[browser-mcp-human-smoke] PASS — human-mode CDP launch/connect contract OK');
    exitCode = 0;
  } catch (err) {
    console.error('[browser-mcp-human-smoke] FAIL:', err instanceof Error ? err.message : String(err));
  } finally {
    server.kill('SIGKILL');
    // The orphaned headed Chrome should be reclaimed by the runtime's own
    // next human session; kill nothing beyond our server here.
    setTimeout(() => process.exit(exitCode), 500);
  }
})();
