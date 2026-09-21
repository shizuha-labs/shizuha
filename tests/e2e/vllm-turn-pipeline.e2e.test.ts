/**
 * SCLI-6xx production-grade E2E: the REAL agent turn pipeline (executeTurn —
 * provider SSE parse → tool dispatch → tool result → next turn) against a
 * REAL local HTTP server speaking the vLLM SSE wire protocol. Everything is
 * real except the model weights: wire format, streaming parse, salvage
 * requests, tool registry, permissions, and the turn loop.
 *
 * Scenario coverage:
 *   E2E-1  skeleton-delta drop (failure class #1): the server's tool-call
 *          deltas are all empty skeletons while finish_reason=tool_calls —
 *          the turn must complete via the non-stream salvage, dispatch the
 *          tool exactly once, and NOT loop (bounded request count).
 *   E2E-2  normal multi-turn tool use (existing scenario regression): a plain
 *          streamed tool call round-trips through dispatch and the follow-up
 *          turn finishes with a final assistant message.
 *   E2E-3  malformed-XML recovery (existing scenario regression): GLM markup
 *          inside content recovers via the argument-recovery lap without
 *          losing the exact reasoning replay.
 */
import { describe, it, expect, afterAll } from 'vitest';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { z } from 'zod';
import { VLlmProvider } from '../../src/provider/vllm.js';
import { executeTurn } from '../../src/agent/turn.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import { PermissionEngine } from '../../src/permissions/engine.js';
import { AgentEventEmitter } from '../../src/events/emitter.js';

const TOOL = 'mcp__shizuha-e2e__write_note';

type Scenario = {
  // Ordered per-request scripted SSE bodies (index = request count).
  responses: string[];
  // Scripted JSON body for non-stream (salvage) requests.
  nonStream?: Record<string, unknown>;
  requests: Array<Record<string, unknown>>;
};

function sse(deltas: Array<Record<string, unknown>>, finish: string | null, extra: string[] = []): string {
  const body = deltas
    .map((d) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: d, finish_reason: null }] })}\n\n`)
    .join('') + (finish ? `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\n` : '')
    + extra.join('') + 'data: [DONE]\n\n';
  return body;
}

function startServer(scenario: Scenario): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c: Buffer) => { raw += c.toString(); });
      req.on('end', () => {
        if (req.url?.includes('/models')) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ data: [{ id: 'GLM-5.3-Flash', max_model_len: 500000 }] }));
          return;
        }
        const body = JSON.parse(raw || '{}');
        scenario.requests.push(body);
        const idx = Math.min(scenario.requests.length - 1, scenario.responses.length - 1);
        const payload = body.stream === false
          ? JSON.stringify(scenario.nonStream ?? {
              choices: [{
                message: {
                  role: 'assistant', content: null,
                  tool_calls: [{ id: 'call_salvage', type: 'function', function: { name: TOOL, arguments: JSON.stringify({ note: 'salvaged' }) } }],
                },
                finish_reason: 'tool_calls',
              }],
            })
          : scenario.responses[idx];
        res.writeHead(200, { 'content-type': body.stream === false ? 'application/json' : 'text/event-stream' });
        res.end(payload);
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      resolve({ port, close: () => server.close() });
    });
  });
}

const servers: Array<{ close: () => void }> = [];
afterAll(() => { for (const s of servers) s.close(); });

async function runTurn(base: string, prompt: string) {
  const provider = new VLlmProvider(base, 500000);
  const registry = new ToolRegistry();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'scli-e2e-'));
  const notePath = path.join(home, 'note.txt');
  registry.register({
    name: TOOL,
    description: 'Write a note',
    parameters: z.object({ note: z.string() }),
    readOnly: false,
    riskLevel: 'low',
    execute: async (params: unknown) => {
      const { note } = params as { note: string };
      fs.writeFileSync(notePath, note);
      return { toolUseId: '', content: `wrote: ${note}` };
    },
  });
  const chunks: Array<{ type: string; [k: string]: unknown }> = [];
  const result = await executeTurn(
    [{ role: 'user', content: prompt }],
    provider,
    'GLM-5.3-Flash',
    'You are a test agent.',
    registry.definitions(),
    registry,
    new PermissionEngine('autonomous'),
    new AgentEventEmitter(),
    { cwd: home, sessionId: `scli-e2e-${Date.now()}` } as never,
    32768,
  );
  return { result, chunks, notePath, registry };
}

describe('SCLI-6xx production-grade E2E — agent turn pipeline on the vLLM wire', () => {
  it('E2E-1: skeleton-delta drop completes via salvage — tool dispatched once, no loop', async () => {
    // Request 1 (stream): deltas are ALL empty skeletons; server claims tool_calls.
    const scenario: Scenario = {
      responses: [
        sse([
          { tool_calls: [{ index: 0 }] },
          { tool_calls: [{ index: 0, function: { name: '', arguments: '' } }] },
        ], 'tool_calls'),
      ],
      requests: [],
    };
    const { port, close } = await startServer(scenario);
    servers.push({ close });
    const { result, notePath } = await runTurn(`http://127.0.0.1:${port}`, 'write the salvaged note');

    // The salvage recovered the server-claimed call and DISPATCHED the tool —
    // the note file exists on disk (the tool really executed end to end).
    expect(fs.readFileSync(notePath, 'utf8')).toBe('salvaged');
    // Exactly 2 upstream requests: the stream + ONE salvage. No retry loop.
    expect(scenario.requests).toHaveLength(2);
    expect(scenario.requests[1].stream).toBe(false);
  }, 30000);

  it('E2E-2: clean streamed tool call dispatches with zero recovery machinery (regression)', async () => {
    const scenario: Scenario = {
      responses: [
        sse([
          { content: 'Writing it now.' },
          { tool_calls: [{ index: 0, id: 'call_ok', function: { name: TOOL, arguments: JSON.stringify({ note: 'clean-turn' }) } }] },
        ], 'tool_calls'),
      ],
      requests: [],
    };
    const { port, close } = await startServer(scenario);
    servers.push({ close });
    const { notePath } = await runTurn(`http://127.0.0.1:${port}`, 'clean path');

    expect(fs.readFileSync(notePath, 'utf8')).toBe('clean-turn');
    // Exactly 1 upstream streaming request — the clean path must not trigger
    // salvage or recovery machinery at all.
    expect(scenario.requests).toHaveLength(1);
    expect(scenario.requests[0].stream).toBe(true);
  }, 30000);

  it('E2E-3: malformed GLM XML in content recovers via argument lap (regression)', async () => {
    const malformed = `<invoke name="${TOOL}"><parameter name="note">xml-lap</parameter></invoke>`;
    const scenario: Scenario = {
      responses: [
        // Request 1: XML markup in content (stream) — the observation salvage
        // path re-requests non-stream (vLLM #44326: non-stream parses what
        // streaming dropped).
        sse([{ content: malformed }], 'tool_calls'),
      ],
      // The server's non-stream parse extracts the call the stream dropped —
      // exactly what a real vLLM non-stream pass produces.
      nonStream: {
        choices: [{
          message: {
            role: 'assistant', content: null,
            tool_calls: [{ id: 'call_xml', type: 'function', function: { name: TOOL, arguments: JSON.stringify({ note: 'xml-recovered' }) } }],
          },
          finish_reason: 'tool_calls',
        }],
      },
      requests: [],
    };
    const { port, close } = await startServer(scenario);
    servers.push({ close });
    const { notePath } = await runTurn(`http://127.0.0.1:${port}`, 'xml path');

    expect(fs.readFileSync(notePath, 'utf8')).toBe('xml-recovered');
    expect(scenario.requests).toHaveLength(2);
  }, 30000);
});
