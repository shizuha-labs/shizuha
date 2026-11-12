/**
 * CTX-5382: Hive direct xAI path (xai:grok-* → Hive TokenPool OAuth lease).
 *
 * Verified against a fake upstream (local HTTP server speaking the OpenAI
 * Chat Completions SSE wire):
 *  - OAuth subscription tokens go to the Grok CLI chat proxy with Grok CLI
 *    client headers (never api.x.ai); console API keys keep api.x.ai and get
 *    no proxy headers.
 *  - x-grok-conv-id header, body prompt_cache_key and body user are all the
 *    durable session id, identical across turns.
 *  - Turn N's serialized request is a byte-exact prefix of turn N+1's
 *    (system, tools and every earlier message unchanged), so xAI's prefix
 *    cache can hit.
 *  - The rolling-hour breaker records per-call cached ratios to a ledger and
 *    fails closed (before any upstream call) once a cap is reached.
 */
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  XaiProvider,
  XAI_API_BASE_URL,
  XAI_OAUTH_PROXY_BASE_URL,
  inferXaiAuthMode,
} from '../../src/provider/xai.js';
import {
  XaiDirectBudget,
  XaiDirectBudgetExceededError,
} from '../../src/provider/xai-direct-budget.js';
import type { ChatMessage, ChatOptions, StreamChunk } from '../../src/provider/types.js';

interface Captured { url: string; headers: http.IncomingHttpHeaders; raw: string; body: Record<string, any> }

let server: http.Server;
let baseURL = '';
const captured: Captured[] = [];
let lastPromptChars = 0;

function sse(res: http.ServerResponse, promptTokens: number, cachedTokens: number): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const base = { id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'grok-4.7' };
  res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' } }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
  res.write(`data: ${JSON.stringify({
    ...base,
    choices: [],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: 5,
      total_tokens: promptTokens + 5,
      prompt_tokens_details: { cached_tokens: cachedTokens },
    },
  })}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = JSON.parse(raw);
      captured.push({ url: req.url || '', headers: req.headers, raw, body });
      // Simulate a prefix cache: everything up to the previous request's
      // message bytes is "cached"; 1 token ≈ 1 char for the fake.
      const promptChars = JSON.stringify(body.messages).length;
      const cached = Math.min(lastPromptChars, promptChars);
      lastPromptChars = promptChars;
      sse(res, promptChars, cached);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  captured.length = 0;
  lastPromptChars = 0;
});

async function drain(gen: AsyncGenerator<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const c of gen) out.push(c);
  return out;
}

const TOOLS = [{
  name: 'read_file',
  description: 'Read a file',
  inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
}] as ChatOptions['tools'];

function opts(sessionId: string): ChatOptions {
  return { model: 'grok-4.7', sessionId, systemPrompt: 'You are a careful engineer.', tools: TOOLS } as ChatOptions;
}

/** Prefix of a JSON array serialization without its closing bracket. */
function arrayPrefix(json: string): string {
  return json.slice(0, -1);
}

describe('CTX-5382 xAI direct path — OAuth proxy wire + cache identity', () => {
  it('infers the credential class from token shape', () => {
    expect(inferXaiAuthMode('xai-AbCdEf0123')).toBe('api_key');
    expect(inferXaiAuthMode('eyJhbGciOi.eyJzdWIiOi.sig')).toBe('oauth_subscription');
    expect(inferXaiAuthMode('')).toBe('api_key');
  });

  it('defaults OAuth leases to the Grok CLI chat proxy and API keys to api.x.ai', () => {
    expect(new XaiProvider('eyJ.a.b', { authMode: 'oauth_subscription' }).baseURL).toBe(XAI_OAUTH_PROXY_BASE_URL);
    expect(new XaiProvider('xai-key').baseURL).toBe(XAI_API_BASE_URL);
    expect(new XaiProvider('xai-key', { authMode: 'api_key' }).baseURL).toBe(XAI_API_BASE_URL);
  });

  it('sends Grok CLI proxy headers + stable cache keys and a byte-stable prefix across turns (OAuth)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xai-direct-'));
    const budget = new XaiDirectBudget({ dir, totalCap: 10_000_000, uncachedCap: 10_000_000 });
    const p = new XaiProvider('oauth-access-token-not-a-console-key', {
      authMode: 'oauth_subscription', baseURL, budget, accountLabel: 'acct@example.com',
    });

    const history: ChatMessage[] = [{ role: 'user', content: 'Turn 1: inspect the repo.' }];
    await drain(p.chat([...history], opts('sess-42')));
    history.push({ role: 'assistant', content: 'ok' }, { role: 'user', content: 'Turn 2: now fix the bug.' });
    await drain(p.chat([...history], opts('sess-42')));
    history.push({ role: 'assistant', content: 'ok' }, { role: 'user', content: 'Turn 3: run the tests.' });
    await drain(p.chat([...history], opts('sess-42')));

    expect(captured).toHaveLength(3);
    for (const c of captured) {
      expect(c.url).toBe('/v1/chat/completions');
      expect(c.headers['authorization']).toBe('Bearer oauth-access-token-not-a-console-key');
      expect(c.headers['x-grok-conv-id']).toBe('sess-42');
      expect(c.headers['x-grok-client-version']).toBe('1.0.45');
      expect(c.headers['x-grok-client-identifier']).toBe('shizuha-cli');
      expect(c.headers['x-grok-client-mode']).toBe('headless');
      expect(c.headers['x-xai-token-auth']).toBe('xai-grok-cli');
      expect(c.headers['x-authenticateresponse']).toBe('authenticate-response');
      expect(c.headers['x-grok-model-override']).toBe('grok-4.7');
      expect(c.headers['accept']).toBe('text/event-stream');
      expect(c.body.prompt_cache_key).toBe('sess-42');
      expect(c.body.user).toBe('sess-42');
      expect(c.body.model).toBe('grok-4.7');
      expect(c.body.stream).toBe(true);
    }
    // Everything but the message tail is byte-identical between turns.
    const stable = (b: Record<string, any>) => JSON.stringify({ ...b, messages: undefined });
    expect(stable(captured[1]!.body)).toBe(stable(captured[0]!.body));
    expect(stable(captured[2]!.body)).toBe(stable(captured[1]!.body));
    // And the message array of turn N is a byte prefix of turn N+1.
    const m = captured.map((c) => JSON.stringify(c.body.messages));
    expect(m[1]!.startsWith(arrayPrefix(m[0]!))).toBe(true);
    expect(m[2]!.startsWith(arrayPrefix(m[1]!))).toBe(true);
    // Raw wire: the bytes before "messages" never change either.
    const head = (raw: string) => raw.slice(0, raw.indexOf('"messages"'));
    expect(head(captured[1]!.raw)).toBe(head(captured[0]!.raw));

    // Ledger: one record per call with the cached ratio the upstream reported.
    const ledger = fs.readFileSync(budget.ledgerPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(ledger).toHaveLength(3);
    expect(ledger.every((r) => r.pool === 'hive' && r.session === 'sess-42' && r.account === 'acct@example.com')).toBe(true);
    expect(ledger[0].cached_ratio).toBe(0);
    expect(ledger[1].cached_ratio).toBeGreaterThan(0.5);
    expect(ledger[2].cached_ratio).toBeGreaterThan(0.6);
    expect(fs.readFileSync(budget.ledgerPath, 'utf8')).not.toContain('oauth-access-token');
  });

  it('keeps the API-key path on plain xAI wire (no Grok CLI proxy headers)', async () => {
    const p = new XaiProvider('xai-console-key', { baseURL });
    await drain(p.chat([{ role: 'user', content: 'hi' }], opts('sess-api')));
    const c = captured[0]!;
    expect(c.headers['authorization']).toBe('Bearer xai-console-key');
    expect(c.headers['x-grok-conv-id']).toBe('sess-api');
    expect(c.body.prompt_cache_key).toBe('sess-api');
    expect(c.headers['x-grok-client-version']).toBeUndefined();
    expect(c.headers['x-xai-token-auth']).toBeUndefined();
  });

  it('fails closed before calling upstream once the rolling-hour cap is reached, and survives restart', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xai-direct-cap-'));
    const mk = () => new XaiDirectBudget({ dir, totalCap: 150, uncachedCap: 10_000 });
    const p = new XaiProvider('tok', { authMode: 'oauth_subscription', baseURL, budget: mk() });
    await drain(p.chat([{ role: 'user', content: 'x'.repeat(200) }], opts('sess-cap')));
    expect(captured).toHaveLength(1);
    await expect(drain(p.chat([{ role: 'user', content: 'again' }], opts('sess-cap'))))
      .rejects.toBeInstanceOf(XaiDirectBudgetExceededError);
    expect(captured).toHaveLength(1); // no upstream spend after the trip
    // A fresh process (pod restart) reloads the persisted window.
    const p2 = new XaiProvider('tok', { authMode: 'oauth_subscription', baseURL, budget: mk() });
    await expect(drain(p2.chat([{ role: 'user', content: 'again' }], opts('sess-cap'))))
      .rejects.toMatchObject({ status: 429, code: 'xai_direct_budget_exhausted' });
    expect(captured).toHaveLength(1);
  });

  it('trips on the uncached cap (cache regression) independently of the total cap', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xai-direct-unc-'));
    const b = new XaiDirectBudget({ dir, totalCap: 1_000_000, uncachedCap: 1_000 });
    b.record({ model: 'grok-4.7', sessionId: 's', account: 'a', promptTokens: 100_000, cachedTokens: 99_900, outputTokens: 50 });
    expect(() => b.assertAvailable()).not.toThrow();
    b.record({ model: 'grok-4.7', sessionId: 's', account: 'a', promptTokens: 100_000, cachedTokens: 1_152, outputTokens: 50 });
    expect(() => b.assertAvailable()).toThrow(/uncached/);
  });

  it('expires usage older than one hour', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xai-direct-win-'));
    let now = 1_000_000;
    const b = new XaiDirectBudget({ dir, totalCap: 100, uncachedCap: 100, now: () => now });
    b.record({ model: 'grok-4.7', sessionId: 's', account: 'a', promptTokens: 200, cachedTokens: 0, outputTokens: 0 });
    expect(() => b.assertAvailable()).toThrow();
    now += 60 * 60 * 1000 + 1;
    expect(() => b.assertAvailable()).not.toThrow();
  });
});
