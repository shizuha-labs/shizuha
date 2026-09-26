/**
 * shizuha2 e81682dd 2026-09-23: a tool result was fed back, the next
 * completion was reasoning-only with completion_tokens=256 while the client
 * had asked for 32768, and the turn ended with no visible answer.
 *
 * Real local HTTP server, real VLlmProvider, real executeTurn, real session
 * loop. The model is scripted.
 */
import { describe, it, expect, afterAll } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { AgentSession } from '../../src/tui/session.js';
import { VLlmProvider } from '../../src/provider/vllm.js';

const MODEL = 'cortex/GLM-5.3-Flash';

type Script = {
  requests: Array<Record<string, unknown>>;
  responses: string[];
};

function chunk(delta: Record<string, unknown>, finish: string | null, usage?: Record<string, number>): string {
  return `data: ${JSON.stringify({
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...(usage ? { usage } : {}),
  })}\n\n`;
}

function sse(parts: string[]): string {
  return parts.join('') + 'data: [DONE]\n\n';
}

function startServer(script: Script): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c: Buffer) => { raw += c.toString(); });
      req.on('end', () => {
        if (req.url?.startsWith('/v1/models')) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ data: [{ id: MODEL, max_model_len: 500000 }] }));
          return;
        }
        const body = JSON.parse(raw || '{}') as Record<string, unknown>;
        script.requests.push(body);
        const idx = Math.min(script.requests.length - 1, script.responses.length - 1);
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(script.responses[idx]);
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        port,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

const closers: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const close of closers) await close();
});

async function runSession(script: Script, prompt: string) {
  const { port, close } = await startServer(script);
  closers.push(close);
  const previousHome = process.env['HOME'];
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'shizuha-e2e-post-tool-'));
  process.env['HOME'] = tempHome;
  const session = new AgentSession();
  let resumed: AgentSession | null = null;
  try {
    await session.init(process.cwd(), MODEL, 'autonomous');
    const provider = new VLlmProvider(`http://127.0.0.1:${port}`, 500000, undefined, 'cortex');
    (session as unknown as { provider: VLlmProvider }).provider = provider;
    await session.submitPrompt(prompt);
    resumed = new AgentSession();
    await resumed.init(process.cwd(), MODEL, 'autonomous');
    let messages: Array<{ role: string; content: unknown }> = [];
    resumed.on('session_resumed', (payload) => {
      messages = (payload as { messages: typeof messages }).messages;
    });
    const ok = await resumed.resumeSession(session.currentSessionId!);
    return { ok, messages, requests: script.requests };
  } finally {
    await session.destroy();
    if (resumed) await resumed.destroy();
    if (previousHome == null) delete process.env['HOME'];
    else process.env['HOME'] = previousHome;
    await fs.rm(tempHome, { recursive: true, force: true });
  }
}

describe('post-tool visible answer on the vLLM wire', () => {
  it('keeps the requested output budget and shows the answer after a 256-token reasoning stop', async () => {
    const toolArgs = JSON.stringify({ command: 'echo post-tool-ok' });
    const script: Script = {
      requests: [],
      responses: [
        sse([
          chunk({ reasoning_content: 'The stylesheet link is missing the prefix.' }, null),
          chunk({
            tool_calls: [{
              index: 0,
              id: 'call_echo',
              type: 'function',
              function: { name: 'bash', arguments: toolArgs },
            }],
          }, 'tool_calls', { prompt_tokens: 1200, completion_tokens: 40 }),
        ]),
        sse([
          chunk({
            reasoning_content: 'CSS fix + favicon done. Now the architecture piece is still open.',
          }, 'length', { prompt_tokens: 1400, completion_tokens: 256 }),
        ]),
        sse([
          chunk({ reasoning_content: 'Say the result.' }, null),
          chunk({
            content: 'STATIC_URL now carries the /guild prefix.',
          }, 'stop', { prompt_tokens: 1700, completion_tokens: 30 }),
        ]),
      ],
    };
    const { ok, messages, requests } = await runSession(script, 'fix the guild static urls');
    expect(ok).toBe(true);
    expect(requests.length).toBe(3);
    for (const body of requests) {
      expect(body.max_tokens).toBe(32768);
    }
    const blob = JSON.stringify(messages);
    expect(blob).toContain('STATIC_URL now carries the /guild prefix.');
    expect(blob).toContain('post-tool-ok');
    expect(blob).not.toContain('response was cut off');
    expect(blob).not.toContain('Your previous response was not visible');
  }, 60000);

  it('does not take an extra sample when the post-tool completion already has the answer', async () => {
    const toolArgs = JSON.stringify({ command: 'echo clean-answer' });
    const script: Script = {
      requests: [],
      responses: [
        sse([
          chunk({
            tool_calls: [{
              index: 0,
              id: 'call_clean',
              type: 'function',
              function: { name: 'bash', arguments: toolArgs },
            }],
          }, 'tool_calls', { prompt_tokens: 800, completion_tokens: 20 }),
        ]),
        sse([
          chunk({ reasoning_content: 'The command printed the marker.' }, null),
          chunk({ content: 'The command printed clean-answer.' }, 'stop', {
            prompt_tokens: 900,
            completion_tokens: 24,
          }),
        ]),
      ],
    };
    const { ok, messages, requests } = await runSession(script, 'run the marker');
    expect(ok).toBe(true);
    expect(requests.length).toBe(2);
    expect(requests.every((body) => body.max_tokens === 32768)).toBe(true);
    const blob = JSON.stringify(messages);
    expect(blob).toContain('The command printed clean-answer.');
    expect(blob).toContain('clean-answer');
  }, 60000);
});
