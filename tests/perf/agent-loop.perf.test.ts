/**
 * SCLI-13: Performance regression gate for the agent loop.
 *
 * Measures turn latency (wall-clock ms from call to first content event) over
 * N cold iterations with a mocked LLM provider, then compares p50/p95 against
 * a committed baseline. Fails if either metric regresses beyond the threshold.
 *
 * The mock provider returns instantly — we measure only the agent-loop
 * overhead (tool registry, permission engine, session store, event routing),
 * not actual LLM latency. That's the signal we want: pure framework overhead.
 *
 * Baseline update: run `npm run perf:update-baseline` to regenerate
 * `tests/perf/baseline.json` from the current measurements.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as url from 'node:url';
import { z } from 'zod';
import { executeTurn } from '../../src/agent/turn.js';
import type { Message } from '../../src/agent/types.js';
import type { ToolHandler, ToolContext } from '../../src/tools/types.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import { PermissionEngine } from '../../src/permissions/engine.js';
import { AgentEventEmitter } from '../../src/events/emitter.js';
import { MockProvider, ResponseBuilder } from '../helpers/mock-provider.js';

// ── Configuration ────────────────────────────────────────────────────────────

const ITERATIONS = 50;           // Warm-up + measurement iterations per scenario
const WARMUP_ITERATIONS = 5;     // Discarded warm-up iterations (JIT stabilization)
const THRESHOLD_FACTOR = 1.35;   // Fail if measured > baseline * 1.35 (35% regression)
const MODEL = 'perf-test-model';
const SYSTEM = 'You are a perf-test agent.';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const BASELINE_PATH = path.join(__dirname, 'baseline.json');

// ── Helpers ───────────────────────────────────────────────────────────────────

function percentile(sortedMs: number[], p: number): number {
  const idx = Math.ceil((p / 100) * sortedMs.length) - 1;
  return sortedMs[Math.max(0, idx)]!;
}

function makeTool(name: string): ToolHandler {
  return {
    name,
    description: `Perf test tool: ${name}`,
    parameters: z.object({ v: z.string().optional() }),
    readOnly: true,
    riskLevel: 'low',
    async execute(): Promise<{ toolUseId: string; content: string }> {
      return { toolUseId: '', content: `result from ${name}` };
    },
  };
}

async function measureTurnLatency(scenario: () => Promise<void>, n: number, warmup: number): Promise<number[]> {
  const samples: number[] = [];
  for (let i = 0; i < n + warmup; i++) {
    const start = performance.now();
    await scenario();
    const elapsed = performance.now() - start;
    if (i >= warmup) samples.push(elapsed);
  }
  return samples.sort((a, b) => a - b);
}

// ── Baseline I/O ──────────────────────────────────────────────────────────────

interface BaselineEntry {
  p50Ms: number;
  p95Ms: number;
  iterations: number;
  recordedAt: string;
}

interface Baseline {
  [scenario: string]: BaselineEntry;
}

function loadBaseline(): Baseline {
  if (!fs.existsSync(BASELINE_PATH)) return {};
  return JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf-8')) as Baseline;
}

// ── Scenarios ─────────────────────────────────────────────────────────────────

describe('agent-loop perf regression gate (SCLI-13)', { timeout: 120_000 }, () => {
  const baseline = loadBaseline();
  const registry = new ToolRegistry();
  // Register a handful of tools to match a realistic session (without full MCP setup)
  for (const name of ['read_file', 'write_file', 'bash', 'glob', 'grep']) {
    registry.register(makeTool(name));
  }
  const toolDefs = registry.definitions();
  const permissions = new PermissionEngine('autonomous');
  const ctx: ToolContext = { cwd: '/tmp/perf-test', sessionId: 'perf-session' };

  // ── Scenario 1: simple text-only response (no tool calls) ────────────────
  it('text-only turn overhead stays within baseline', async () => {
    const provider = new MockProvider();
    const messages: Message[] = [{ role: 'user', content: 'Hello', timestamp: Date.now() }];

    const scenario = async () => {
      provider.queueResponse(ResponseBuilder.textOnly('Hello back!'));
      const emitter = new AgentEventEmitter();
      await executeTurn(messages, provider, MODEL, SYSTEM, toolDefs, registry, permissions, emitter, ctx, 4096, 0);
    };

    const samples = await measureTurnLatency(scenario, ITERATIONS, WARMUP_ITERATIONS);
    const p50 = percentile(samples, 50);
    const p95 = percentile(samples, 95);

    console.log(`[text-only] p50=${p50.toFixed(3)}ms  p95=${p95.toFixed(3)}ms  (${ITERATIONS} iters)`);

    const b = baseline['text-only'];
    if (!b) {
      console.warn(`[BOOTSTRAP] No baseline for "text-only" — p50=${p50.toFixed(3)}ms p95=${p95.toFixed(3)}ms. Run \`npm run perf:update-baseline\` and commit baseline.json.`);
      return;
    }
    // Use an absolute-noise epsilon so near-zero baselines don't flap on CI runners that run
    // 2-10× slower than a dev machine. max(relative, absolute) gracefully handles both regimes.
    const NOISE_MS = 0.5;
    expect(p50, `p50 regression: ${p50.toFixed(1)}ms vs baseline ${b.p50Ms.toFixed(1)}ms`).toBeLessThanOrEqual(Math.max(b.p50Ms * THRESHOLD_FACTOR, b.p50Ms + NOISE_MS));
    expect(p95, `p95 regression: ${p95.toFixed(1)}ms vs baseline ${b.p95Ms.toFixed(1)}ms`).toBeLessThanOrEqual(Math.max(b.p95Ms * THRESHOLD_FACTOR, b.p95Ms + NOISE_MS));
  });

  // ── Scenario 2: single tool call + result ────────────────────────────────
  it('single tool-call turn overhead stays within baseline', async () => {
    const provider = new MockProvider();
    const messages: Message[] = [{ role: 'user', content: 'Read file.', timestamp: Date.now() }];

    const scenario = async () => {
      // Turn 1: model calls the tool
      provider.queueResponse(ResponseBuilder.withToolCalls('', [{ id: 'tc1', name: 'read_file', input: { v: 'foo.ts' } }]));
      // Turn 2: model produces text after seeing tool result
      provider.queueResponse(ResponseBuilder.textOnly('Done.'));
      const emitter = new AgentEventEmitter();
      await executeTurn(messages, provider, MODEL, SYSTEM, toolDefs, registry, permissions, emitter, ctx, 4096, 0);
    };

    const samples = await measureTurnLatency(scenario, ITERATIONS, WARMUP_ITERATIONS);
    const p50 = percentile(samples, 50);
    const p95 = percentile(samples, 95);

    console.log(`[tool-call] p50=${p50.toFixed(3)}ms  p95=${p95.toFixed(3)}ms  (${ITERATIONS} iters)`);

    const b = baseline['tool-call'];
    if (!b) {
      console.warn(`[BOOTSTRAP] No baseline for "tool-call" — p50=${p50.toFixed(3)}ms p95=${p95.toFixed(3)}ms. Run \`npm run perf:update-baseline\` and commit baseline.json.`);
      return;
    }
    const NOISE_MS = 0.5;
    expect(p50, `p50 regression: ${p50.toFixed(1)}ms vs baseline ${b.p50Ms.toFixed(1)}ms`).toBeLessThanOrEqual(Math.max(b.p50Ms * THRESHOLD_FACTOR, b.p50Ms + NOISE_MS));
    expect(p95, `p95 regression: ${p95.toFixed(1)}ms vs baseline ${b.p95Ms.toFixed(1)}ms`).toBeLessThanOrEqual(Math.max(b.p95Ms * THRESHOLD_FACTOR, b.p95Ms + NOISE_MS));
  });

  // ── Scenario 3: multi-turn session with growing context ──────────────────
  it('multi-turn session overhead stays within baseline', async () => {
    const scenario = async () => {
      const provider = new MockProvider();
      const messages: Message[] = [];
      for (let turn = 0; turn < 5; turn++) {
        messages.push({ role: 'user', content: `Turn ${turn}: do something`, timestamp: Date.now() });
        provider.queueResponse(ResponseBuilder.textOnly(`Turn ${turn} answer.`));
        const emitter = new AgentEventEmitter();
        const r = await executeTurn(messages, provider, MODEL, SYSTEM, toolDefs, registry, permissions, emitter, ctx, 32768, 0);
        if (r.assistantMessage) messages.push(r.assistantMessage);
      }
    };

    const samples = await measureTurnLatency(scenario, Math.max(10, Math.floor(ITERATIONS / 5)), WARMUP_ITERATIONS);
    const p50 = percentile(samples, 50);
    const p95 = percentile(samples, 95);

    console.log(`[multi-turn-5] p50=${p50.toFixed(3)}ms  p95=${p95.toFixed(3)}ms`);

    const b = baseline['multi-turn-5'];
    if (!b) {
      console.warn(`[BOOTSTRAP] No baseline for "multi-turn-5" — p50=${p50.toFixed(3)}ms p95=${p95.toFixed(3)}ms. Run \`npm run perf:update-baseline\` and commit baseline.json.`);
      return;
    }
    const NOISE_MS = 0.5;
    expect(p50, `p50 regression`).toBeLessThanOrEqual(Math.max(b.p50Ms * THRESHOLD_FACTOR, b.p50Ms + NOISE_MS));
    expect(p95, `p95 regression`).toBeLessThanOrEqual(Math.max(b.p95Ms * THRESHOLD_FACTOR, b.p95Ms + NOISE_MS));
  });
});
