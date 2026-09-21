/**
 * SCLI-3xx: false-positive "Provider stall" banner while tokens stream.
 *
 * shizuha4, 2026-08-08. Operator reported the TUI showing
 *
 *   ⚠ Provider stall 1m 6s · Esc to cancel · /model to switch (queue paused)
 *
 * while the model was ACTIVELY streaming output tokens. Root cause was a
 * desync between two writers of `stalledMs` in useAgentSession:
 *
 *   - the provider_status `request_wait` / `stall_timeout` handlers set
 *     positive `stalledMs` directly but did NOT update `prevStalledRef`;
 *   - the 1s idle watchdog is the only path that CLEARS the banner, and its
 *     change-detection gate was `prevStalledRef === 0 ? nextStall > 0 : …`.
 *     With `prevStalledRef` stuck at 0 and `nextStall === 0` (streaming
 *     resumed, lastAgentEventAtRef fresh on every chunk), the gate evaluated
 *     to `0 === 0 ? 0 > 0 : …` => false — so the banner never cleared and
 *     froze at its last positive value while the answer streamed.
 *
 * Fix (both halves, pinned here at the source level):
 *   1. Direct writers now sync `prevStalledRef.current` to the value they
 *      set, so the watchdog sees the positive state.
 *   2. The watchdog's clear path is authoritative: when `nextStall === 0` it
 *      reconciles whenever `prevStalledRef !== 0` — it can no longer be
 *      gated out of clearing by a stale ref.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isProviderRecoverySignal } from '../../src/tui/hooks/useAgentSession.js';
import type { AgentEvent } from '../../src/events/types.js';

const hookSrc = fs.readFileSync(
  path.resolve(import.meta.dirname!, '../../src/tui/hooks/useAgentSession.ts'),
  'utf-8',
);

describe('provider-status stall writers keep prevStalledRef in sync', () => {
  it("syncs prevStalledRef when request_wait/request_start set stalledMs", () => {
    const block = hookSrc.slice(
      hookSrc.indexOf("if (statusCode === 'request_wait' || statusCode === 'request_start')"),
    );
    const handlerEnd = block.indexOf("const label = event.message.trim();");
    const handler = block.slice(0, handlerEnd);
    expect(handler).toContain('const stallMs = longWaitDisplayMs(elapsed, PROVIDER_SOFT_STALL_MS);');
    expect(handler).toContain('setStalledMs(stallMs);');
    expect(
      handler,
      'direct stalledMs writers must also sync prevStalledRef so the idle '
        + 'watchdog (the only clear path) sees the positive state',
    ).toContain('prevStalledRef.current = stallMs;');
    expect(handler).not.toContain('appendSystemEntry(');
    expect(handler).toContain("setProcessingLabel('Waiting for model response...');");
    expect(handler).toMatch(/setProcessingLabel\('Waiting for model response\.\.\.'\);\s*break;\s*}/);
  });

  it("syncs prevStalledRef when stall_timeout sets stalledMs", () => {
    const block = hookSrc.slice(hookSrc.indexOf("statusCode === 'stall_timeout'"));
    const handler = block.slice(0, block.indexOf("if (statusCode === 'request_wait'"));
    expect(handler).toContain('const stallMs = longWaitDisplayMs(elapsed, PROVIDER_SOFT_STALL_MS);');
    expect(handler).toContain('setStalledMs(stallMs);');
    expect(handler).toContain('prevStalledRef.current = stallMs;');
  });

  it('centrally clears all transient wait state on recovery evidence', () => {
    const listenerStart = hookSrc.indexOf("s.on('agent_event', (event: AgentEvent) =>");
    const listenerBlock = hookSrc.slice(listenerStart);
    const listener = listenerBlock.slice(0, listenerBlock.indexOf('switch (event.type)'));
    expect(listener).toContain('isProviderRecoverySignal(event)');
    expect(listener).toContain('providerWaitNoticeActiveRef.current');
    expect(listener).toContain('setRetryNotice(null);');
    expect(listener).toContain('setError(null);');
    expect(listener).toContain('setStalledMs(0);');
    expect(listener).toContain('stalledMsRef.current = 0;');
    expect(listener).toContain('prevStalledRef.current = 0;');
  });
});

describe('retryable API errors do not pin the red header chrome', () => {
  it('leaves setError for terminal failures only', () => {
    const errorCase = hookSrc.slice(
      hookSrc.indexOf("case 'error':"),
      hookSrc.indexOf("case 'complete':"),
    );
    const retryBranch = errorCase.slice(0, errorCase.indexOf('} else {'));
    expect(retryBranch).toContain('setRetryNotice(');
    expect(
      retryBranch,
      'in-flight 429/ECONNRESET retries must not call setError — that is the red ✗ banner above the header',
    ).not.toMatch(/setError\(event\.error\)/);
    expect(errorCase.slice(errorCase.indexOf('} else {'))).toContain('setError(event.error);');
  });

  it('idle watchdog does not treat a running tool as a provider stall', () => {
    const tick = hookSrc.slice(
      hookSrc.indexOf('const waitFresh = providerWaitActiveRef.current'),
      hookSrc.indexOf('if (nextStall > 0 && !stallAnnouncedRef.current)'),
    );
    expect(tick).toContain("const toolsRunning = currentToolsRef.current.some((tool) => tool.status === 'running')");
    expect(tick).toContain('const nextStall = toolsRunning');
    expect(tick).toContain('? 0');
  });
});

describe('provider retry notice follows the live provider state', () => {
  const event = (value: AgentEvent): AgentEvent => value;
  const stallTimeout = event({
    type: 'provider_status',
    code: 'stall_timeout',
    message: 'no response headers',
    elapsedMs: 66_000,
    timestamp: 1,
  });
  const retryWait = event({
    type: 'provider_status',
    code: 'request_wait',
    message: 'Waiting for model response...',
    elapsedMs: 5_000,
    timestamp: 2,
  });

  it('keeps the warning while retrying, then clears it on the first streamed token', () => {
    // Production order: attempt 1 times out -> attempt 2 waits -> attempt 2
    // streams. executeTurn has not returned yet at the final step.
    expect(isProviderRecoverySignal(stallTimeout)).toBe(false);
    expect(isProviderRecoverySignal(retryWait)).toBe(false);
    expect(isProviderRecoverySignal(event({
      type: 'content',
      text: 'Recovered output',
      timestamp: 3,
    }))).toBe(true);
  });

  it('clears on non-text provider output across a second retry cycle', () => {
    // A tool-only model response and token telemetry are equally authoritative
    // recovery evidence; the notice must not depend on visible prose.
    expect(isProviderRecoverySignal(stallTimeout)).toBe(false);
    expect(isProviderRecoverySignal(event({
      type: 'token_progress',
      inputTokens: 1_000,
      outputTokens: 1,
      outputTokensPerSec: 1,
      estimated: false,
      timestamp: 4,
    }))).toBe(true);
    expect(isProviderRecoverySignal(event({
      type: 'tool_start',
      toolCallId: 'call-1',
      toolName: 'read',
      input: {},
      timestamp: 5,
    }))).toBe(true);
  });

  it('does not mistake local activity for provider recovery', () => {
    expect(isProviderRecoverySignal(event({ type: 'turn_start', turnIndex: 1, timestamp: 6 }))).toBe(false);
    expect(isProviderRecoverySignal(event({ type: 'thinking', timestamp: 7 }))).toBe(false);
    expect(isProviderRecoverySignal(event({
      type: 'background_task',
      status: 'progress',
      taskId: 'bg-1',
      description: 'still running',
      runningMs: 5_000,
      timestamp: 8,
    }))).toBe(false);
  });
});

describe('idle watchdog: authoritative clear, hold while keepalives fresh (SCLI-522)', () => {
  const tick = hookSrc.slice(
    hookSrc.indexOf('const waitFresh = providerWaitActiveRef.current'),
    hookSrc.indexOf('if (nextStall > 0 && !stallAnnouncedRef.current)'),
  );

  it("holds the direct writers' banner while provider keepalives are fresh", () => {
    // Keepalives deliberately do NOT refresh lastAgentEventAtRef (SCLI-388 —
    // the idle watchdog must still catch a hang masked by fake keepalives), so
    // clearing on `idleMs < STALL_WARN_MS` erased the direct writers' 30s card
    // within a second of every keepalive: QA reconfirmation 2026-09-14 measured
    // the card invisible on the cortex/ollama lanes. While the wait is live and
    // fresh the watchdog must HOLD the direct writer's value instead.
    expect(tick).toContain('const waitFresh = providerWaitActiveRef.current');
    expect(tick).toContain('Date.now() - lastProviderWaitAtRef.current < PROVIDER_WAIT_FRESH_MS');
    expect(tick).toContain(
      '? Math.max(stalledMsRef.current, longWaitDisplayMs(idleMs, STALL_WARN_MS))',
    );
  });

  it('reconciles the clear whenever nextStall is 0 and either stall source is showing', () => {
    // The actual state ref is the fail-safe if a future direct writer forgets
    // to sync prevStalledRef. The watchdog remains the authoritative clear —
    // once keepalives stop being fresh, the idle clock decides again.
    expect(tick).toContain(
      "const changed = nextStall === 0\n          ? prevStalledRef.current !== 0 || stalledMsRef.current !== 0",
    );
  });

  it('still escalates a fresh real stall from the idle path once keepalives stop', () => {
    // When no direct writer set a stall, prevStalledRef stays 0 and a real
    // idle stall (no agent events for >STALL_WARN_MS) must still fire.
    expect(tick).toContain(
      ": prevStalledRef.current === 0\n            ? nextStall > 0",
    );
  });

  it('stamps keepalive freshness in the request_wait/request_start handler', () => {
    const block = hookSrc.slice(
      hookSrc.indexOf("if (statusCode === 'request_wait' || statusCode === 'request_start')"),
    );
    const handler = block.slice(0, block.indexOf('const stallMs = longWaitDisplayMs'));
    expect(handler).toContain('providerWaitActiveRef.current = true;');
    expect(handler).toContain('lastProviderWaitAtRef.current = Date.now();');
  });

  it('ends the hold on recovery evidence and at turn boundaries', () => {
    const listenerStart = hookSrc.indexOf("s.on('agent_event', (event: AgentEvent) =>");
    const listener = hookSrc.slice(listenerStart, listenerStart + 4000);
    expect(
      listener,
      'the recovery-signal block must end the keepalive hold',
    ).toContain('providerWaitActiveRef.current = false;');
    const turnStart = hookSrc.slice(
      hookSrc.indexOf("case 'turn_start':"),
      hookSrc.indexOf("case 'background_task'"),
    );
    expect(turnStart).toContain('providerWaitActiveRef.current = false;');
  });

  it('does not persist soft wait warnings into transcript history', () => {
    const announcement = hookSrc.slice(
      hookSrc.indexOf('if (nextStall > 0 && !stallAnnouncedRef.current)'),
      hookSrc.indexOf('} else if (nextStall === 0)'),
    );
    expect(announcement).not.toContain('appendSystemEntry(');
  });
});
