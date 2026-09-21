/**
 * Local OpenAI-compatible vLLM stand-in for process-level TUI e2e.
 *
 * The real `dist/shizuha.js` talks HTTP. Tests script /v1/models and
 * /v1/chat/completions without touching Cortex/GLM.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface MockChatRequest {
  model?: string;
  messages?: Array<{ role?: string; content?: unknown }>;
  metadata?: { request_kind?: string };
  max_tokens?: number;
}

export type MockChatScript =
  | { kind: 'text'; text: string; finishReason?: 'stop' | 'length' }
  | { kind: 'hang' };

export interface MockVllmServer {
  url: string;
  port: number;
  chatCalls: MockChatRequest[];
  close: () => Promise<void>;
}

export function isCompactionRequest(req: MockChatRequest): boolean {
  return (req.metadata?.request_kind ?? '').toLowerCase() === 'compaction';
}

export function startMockVllmServer(opts: {
  modelId: string;
  maxModelLen: number;
  script: (req: MockChatRequest, callIndex: number) => MockChatScript;
}): Promise<MockVllmServer> {
  const chatCalls: MockChatRequest[] = [];
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        data: [{ id: opts.modelId, max_model_len: opts.maxModelLen }],
      }));
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      req.on('end', () => {
        let parsed: MockChatRequest = {};
        try {
          parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as MockChatRequest;
        } catch {
          res.writeHead(400);
          res.end('invalid json');
          return;
        }
        chatCalls.push(parsed);
        const script = opts.script(parsed, chatCalls.length);
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        if (script.kind === 'hang') {
          const abort = () => {
            try { res.end(); } catch { /* already closed */ }
          };
          req.on('close', abort);
          res.on('close', abort);
          return;
        }
        writeSseText(res, opts.modelId, script.text, script.finishReason ?? 'stop');
        res.end();
      });
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        port: address.port,
        chatCalls,
        close: () => new Promise((done, fail) => {
          server.close((err) => err ? fail(err) : done());
        }),
      });
    });
    server.on('error', reject);
  });
}

function writeSseText(
  res: http.ServerResponse,
  model: string,
  text: string,
  finishReason: 'stop' | 'length',
): void {
  const base = { id: 'cmpl-e2e', object: 'chat.completion.chunk', created: 1, model };
  res.write(`data: ${JSON.stringify({
    ...base,
    choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }],
  })}\n\n`);
  res.write(`data: ${JSON.stringify({
    ...base,
    choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
  })}\n\n`);
  res.write(`data: ${JSON.stringify({
    ...base,
    usage: { prompt_tokens: 128, completion_tokens: Math.max(1, Math.ceil(text.length / 4)) },
    choices: [],
  })}\n\n`);
  res.write('data: [DONE]\n\n');
}
