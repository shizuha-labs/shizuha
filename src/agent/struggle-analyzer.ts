import { logger } from '../utils/logger.js';
import type { AgentEventEmitter } from '../events/emitter.js';
import type { StruggleEvent } from '../events/types.js';
import type { TurnTelemetryWindow, TurnTelemetryRecord } from '../telemetry/turn-telemetry.js';

/**
 * SCLI-32: detect when an agent run is STRUGGLING and emit a heuristic-only
 * `struggle` event (no LLM). Ported from the shizuha prototype to shizuha-beta
 * per the architect ruling: it drives the completed-turn heuristics
 * (THRASH / ERROR_DENSITY / LONG_RUN) off the REAL SCLI-31 telemetry window
 * (`TurnTelemetryRecord[]` via `getTurnTelemetryWindow()`) instead of a private
 * event-accumulated copy, and STALL off the SCLI-22 provider watchdog signal
 * (`provider_status { code: 'stall_timeout' }`) emitted by anthropic.ts and
 * vllm.ts when their inactivity timers trip — not a rebuilt idle timer.
 *
 * Output is beta's `StruggleEvent` shape (`kind` + `windowSummary`), emitted on
 * the AgentEventEmitter as a `struggle` event — the SCLI-33 auto-filer
 * (`setupStrugglePulseAutoFiler`) consumes it and files a deduped Pulse bug,
 * and SCLI-34/74 read the same signal for the Grafana struggle panels.
 *
 * Wiring: construct once per run with the active emitter + telemetry window,
 * call `onTurnRecorded()` immediately after each `recordTurnTelemetry()` (so the
 * just-finished turn is already in the window), and `destroy()` at run teardown.
 */

export interface StruggleAnalyzerConfig {
  /** Retained for call-site compat; no longer used to drive a timer.
   *  STALL is driven by the SCLI-22 provider watchdog (provider_status stall_timeout). */
  stallIdleMs: number;
  /** Consecutive zero-progress turns that define THRASH. */
  thrashWindowTurns: number;
  /** Tool error-rate (0–1) over the window that counts as systematic failure. */
  errorDensityThreshold: number;
  /** Min total tool calls in the THRASH window before THRASH can fire. */
  thrashMinTools: number;
  /** Min failed/no-op tool calls in the THRASH window before THRASH can fire. */
  thrashMinFailures: number;
  /** Number of recent turns ERROR_DENSITY is computed over. */
  errorDensityWindow: number;
  /** Min completed turns before ERROR_DENSITY can fire (avoids 1-failure false positives). */
  errorDensityMinTurns: number;
  /** Min total tool calls in the window before ERROR_DENSITY can fire. */
  errorDensityMinTools: number;
  /** Turn index at/after which LONG_RUN fires (once per run). */
  longRunThreshold: number;
}

export const DEFAULT_STRUGGLE_CONFIG: Required<StruggleAnalyzerConfig> = {
  stallIdleMs: 90_000,
  thrashWindowTurns: 3,
  errorDensityThreshold: 0.5,
  thrashMinTools: 3,
  thrashMinFailures: 2,
  errorDensityWindow: 10,
  errorDensityMinTurns: 3,
  errorDensityMinTools: 5,
  longRunThreshold: 40,
};

interface WindowSummary {
  turnsAnalyzed: number;
  errorRate: number;
  noOpRate: number;
  avgTurnMs: number;
}

export class StruggleAnalyzer {
  private readonly config: Required<StruggleAnalyzerConfig>;
  private readonly emitter: AgentEventEmitter;
  private readonly window: TurnTelemetryWindow;
  private readonly runId: string;
  private readonly agent: string | undefined;
  private unsubs: Array<() => void> = [];
  private longRunEmitted = false;
  private stallEmitted = false;
  // Per-pattern latches: fire ONCE per run, never reset (aoi architect review).
  // Resetting on progress caused re-fires and duplicate Pulse bug storms for THRASH/ERROR_DENSITY.
  private thrashLatched = false;
  private errorDensityLatched = false;

  constructor(
    emitter: AgentEventEmitter,
    window: TurnTelemetryWindow,
    opts: { runId: string; agent?: string },
    config?: Partial<StruggleAnalyzerConfig>,
  ) {
    this.emitter = emitter;
    this.window = window;
    this.runId = opts.runId;
    this.agent = opts.agent;
    this.config = { ...DEFAULT_STRUGGLE_CONFIG, ...config };

    // SCLI-22 adaptive watchdog signals STALL via provider_status { code: 'stall_timeout' }.
    // Fired by anthropic.ts / vllm.ts when their inactivity timers trip. stallEmitted gates
    // it to fire once per turn even when the provider retries multiple times.
    this.unsubs.push(this.emitter.on('provider_status', (event) => {
      const ev = event as { code?: string; message: string };
      if (ev.code === 'stall_timeout' && !this.stallEmitted) {
        this.stallEmitted = true;
        const summary = this.summarize(this.window.query(this.config.errorDensityWindow));
        this.emit('STALL', ev.message, summary);
      }
    }));
  }

  /**
   * No-op — retained for call-site backwards compatibility.
   * STALL is now driven by the SCLI-22 provider watchdog signal, so the idle
   * timer arm/suspend lifecycle is gone from StruggleAnalyzer.
   */
  onTurnStart(): void {}

  /**
   * No-op — retained for call-site backwards compatibility.
   */
  suspendStall(): void {}

  /**
   * Run the completed-turn heuristics. MUST be called right after
   * `recordTurnTelemetry()` so the just-finished turn is in the window.
   *
   * `continuing` must reflect the actual post-decision loop state — true
   * whenever the loop will execute another LLM turn (tool calls present, OR
   * max-tokens / silent-gen / thinking-only / interrupted recovery paths that
   * still `continue` the loop with no tool calls). Pass false ONLY on the
   * genuine terminal answer turn (the loop is about to break and deliver the
   * final response). LONG_RUN is skipped when `continuing === false` to avoid
   * filing a bug on the turn that finally resolves the run.
   * Do NOT use `result.toolCalls.length > 0` as the proxy — recovery turns
   * have no tool calls but still continue the loop.
   */
  onTurnRecorded(continuing = true): void {
    this.stallEmitted = false; // completed turn resets the per-turn stall gate
    this.checkThrash();
    this.checkErrorDensity();
    if (continuing) this.checkLongRun();
  }

  private checkThrash(): void {
    if (this.thrashLatched) return; // fire once per run (aoi review)
    const recent = this.window.query(this.config.thrashWindowTurns);
    if (recent.length < this.config.thrashWindowTurns) return;
    if (!recent.every((r) => r.filesEdited === 0)) return;
    // THRASH = K consecutive zero-file-edit turns AND a high tool error-rate.
    // The error signal is REQUIRED (review P2): a zero-edit window alone — even
    // with high no-op churn — is the NORMAL profile for read-only review/QA/
    // investigation agents (revi/kei/zen), so keying on it false-flags healthy
    // runs and storms the auto-filer. Genuine tool failures separate a stuck
    // write-loop from healthy read-only work; ERROR_DENSITY covers error loops
    // that aren't zero-edit.
    const totalTools = recent.reduce((s, r) => s + r.toolOk + r.toolError + r.toolNoOp, 0);
    const failedTools = recent.reduce((s, r) => s + r.toolError + r.toolNoOp, 0);
    if (totalTools < this.config.thrashMinTools || failedTools < this.config.thrashMinFailures) return;
    const summary = this.summarize(recent);
    if (summary.errorRate < this.config.errorDensityThreshold) return;
    this.thrashLatched = true;
    this.emit(
      'THRASH',
      `${recent.length} consecutive turns with zero file edits and ${Math.round(summary.errorRate * 100)}% tool error-rate — a non-progressing failure loop`,
      summary,
    );
  }

  private checkErrorDensity(): void {
    if (this.errorDensityLatched) return; // fire once per run (aoi review)
    const window = this.window.query(this.config.errorDensityWindow);
    if (window.length < this.config.errorDensityMinTurns) return;
    const totalTools = window.reduce((s, r) => s + r.toolOk + r.toolError + r.toolNoOp, 0);
    if (totalTools < this.config.errorDensityMinTools) return;
    const summary = this.summarize(window);
    if (summary.errorRate < this.config.errorDensityThreshold) return;
    this.errorDensityLatched = true;
    this.emit(
      'ERROR_DENSITY',
      `${Math.round(summary.errorRate * 100)}% tool error-rate over the last ${window.length} turns — systematic failures`,
      summary,
    );
  }

  private checkLongRun(): void {
    if (this.longRunEmitted) return;
    const latest = this.window.query(1)[0];
    if (!latest || latest.turnIndex < this.config.longRunThreshold) return;
    this.longRunEmitted = true;
    this.emit(
      'LONG_RUN',
      `Run reached turn ${latest.turnIndex} without terminal resolution`,
      this.summarize(this.window.query(this.config.errorDensityWindow)),
    );
  }

  /** Aggregate a set of records into the StruggleEvent.windowSummary shape. */
  private summarize(records: TurnTelemetryRecord[]): WindowSummary {
    const turnsAnalyzed = records.length;
    if (turnsAnalyzed === 0) {
      return { turnsAnalyzed: 0, errorRate: 0, noOpRate: 0, avgTurnMs: 0 };
    }
    let ok = 0, err = 0, noop = 0, ms = 0;
    for (const r of records) {
      ok += r.toolOk;
      err += r.toolError;
      noop += r.toolNoOp;
      ms += r.timeOnTurnMs;
    }
    const tools = ok + err + noop;
    return {
      turnsAnalyzed,
      errorRate: tools > 0 ? err / tools : 0,
      noOpRate: tools > 0 ? noop / tools : 0,
      avgTurnMs: Math.round(ms / turnsAnalyzed),
    };
  }

  private emit(kind: StruggleEvent['kind'], diagnosis: string, windowSummary: WindowSummary): void {
    const event: StruggleEvent = {
      type: 'struggle',
      runId: this.runId,
      ...(this.agent ? { agent: this.agent } : {}),
      kind,
      diagnosis,
      windowSummary,
      timestamp: Date.now(),
    };
    logger.warn(
      { kind, runId: this.runId, errorRate: windowSummary.errorRate, turns: windowSummary.turnsAnalyzed },
      'StruggleAnalyzer: struggle detected',
    );
    this.emitter.emit(event);
  }

  destroy(): void {
    for (const unsub of this.unsubs) unsub();
    this.unsubs = [];
  }
}
