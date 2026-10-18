import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { logger } from '../../src/utils/logger.js';
import { VLlmProvider } from '../../src/provider/vllm.js';
import type { StreamChunk } from '../../src/provider/types.js';

let home: string;
const corrupt = '{"synthetic":';
const tool = 'diagnostic_run';
const dir = () => path.join(home, '.shizuha', 'repro');
const files = () => fs.existsSync(dir()) ? fs.readdirSync(dir()) : [];

async function turn(name = tool, args = corrupt): Promise<StreamChunk[]> {
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
    if (String(url).endsWith('/models')) return Response.json({ data: [{ id: 'synthetic-model', max_model_len: 500000 }] });
    const frames = [
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'synthetic_call', type: 'function', function: { name, arguments: args } }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    ];
    return new Response(frames.map(f => `data: ${JSON.stringify(f)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  }));
  const provider = new VLlmProvider('http://offline.invalid', 500000);
  const chunks: StreamChunk[] = [];
  for await (const chunk of provider.chat([{ role: 'user', content: 'Synthetic diagnostic fixture only.' }], {
    model: 'synthetic-model', maxTokens: 2048, thinkingLevel: 'off',
    tools: [{ name, description: 'Synthetic diagnostic fixture', inputSchema: { type: 'object', properties: {} } }], toolChoice: 'auto',
  })) chunks.push(chunk);
  expect(chunks.filter(c => c.type === 'tool_use_end')).toEqual([expect.objectContaining({ input: {} })]);
  return chunks;
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'private-repro-fixture-'));
  vi.spyOn(logger, 'warn').mockImplementation(() => {});
  vi.stubEnv('HOME', home);
  vi.stubEnv('VLLM_STREAM_WITH_TOOLS', '1');
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); fs.rmSync(home, { recursive: true, force: true }); });

describe('actual provider corrupt-argument diagnostic sink', () => {
  it('writes the existing synthetic capture to writable user state with private modes', async () => {
    await turn();
    expect(files()).toHaveLength(1);
    const file = path.join(dir(), files()[0]!);
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(data.tool).toBe(tool); expect(data.corruptArgs).toBe(corrupt);
    expect(data.request.messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'user' })]));
    expect(fs.statSync(dir()).mode & 0o777).toBe(0o700);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const warnings = JSON.stringify(vi.mocked(logger.warn).mock.calls);
    expect(warnings).not.toContain(corrupt);
    expect(warnings).not.toContain(tool);
  });
  it('keeps three distinct captures per full tool name even at the same timestamp', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1700000000000);
    for (let i = 0; i < 4; i++) await turn();
    expect(files()).toHaveLength(3);
    await turn('diagnostic_other'); expect(files()).toHaveLength(4);
  });
  it('bounds long untrusted tool filenames while retaining the full name privately', async () => {
    const name = 'synthetic_' + 'x'.repeat(1100);
    await turn(name); expect(files()).toHaveLength(1);
    expect(Buffer.byteLength(files()[0]!)).toBeLessThan(256);
    expect(JSON.parse(fs.readFileSync(path.join(dir(), files()[0]!), 'utf8')).tool).toBe(name);
    for (let i = 0; i < 3; i++) await turn(name);
    expect(files()).toHaveLength(3);
    await turn(name + 'y'); expect(files()).toHaveLength(4);
  });
  it('does not broaden capture to valid empty arguments', async () => {
    await turn(tool, '{}'); expect(files()).toEqual([]);
  });
  it('refuses symlink or nonprivate capture directories without writing through them', async () => {
    fs.mkdirSync(path.join(home, '.shizuha'));
    const outside = path.join(home, 'outside'); fs.mkdirSync(outside, { mode: 0o700 });
    fs.symlinkSync(outside, dir()); await turn(); expect(fs.readdirSync(outside)).toEqual([]);
    fs.unlinkSync(dir()); fs.mkdirSync(dir(), { mode: 0o755 });
    await turn(); expect(files()).toEqual([]);
  });
  it('preserves nonfatal provider output when user-state creation is unavailable', async () => {
    fs.writeFileSync(path.join(home, '.shizuha'), 'synthetic collision');
    await turn(); expect(files()).toEqual([]);
    expect(fs.readFileSync(path.join(home, '.shizuha'), 'utf8')).toBe('synthetic collision');
  });
});
