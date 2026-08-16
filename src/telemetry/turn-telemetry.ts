/**
 * Run-telemetry sink (SCLI-31) — consolidate per-turn signals into a
 * queryable rolling window. The SCLI-30 observability FOUNDATION: SCLI-32
 * (struggle analyzer) and fleet alerting read this.
 *
 * Fed by the AgentEvent stream: tool_complete (outcome + file-edit count),
 * perf_metrics (TTFT/decode/cache, SCLI-21), and turn_complete (tokens +
 * duration, the finalize trigger). Pure accumulation — no I/O here; callers
 * wire the persistence sinks (state.db for TUI, JSONL for fleet agents).
 */

export type ToolOutcome = 'ok' | 'error' | 'no_op';

export interface ToolCallRecord {
  name: string;
  outcome: ToolOutcome;
  durationMs: number;
}

export interface TurnTelemetryRecord {
  runId: string;
  agent?: string;
  turnIndex: number;
  ts: number;
  model: string;
  provider: string;
  toolCalls: ToolCallRecord[];
  toolOk: number;
  toolError: number;
  toolNoOp: number;
  /** Net file-mutating tool calls that completed OK this turn. */
  filesEdited: number;
  inputTokens: number;
  outputTokens: number;
  ttftMs: number | null;
  decodeTokensPerSec: number | null;
  timeOnTurnMs: number;
  loopGuardHits: number;
  promptTokenEstimate?: number;
  systemOverheadTokens?: number;
  messageTokens?: number;
  toolDefinitionTokens?: number;
  sourceKind?: 'heartbeat' | 'scheduled' | 'user' | 'unknown';
  compactionAction?: 'none' | 'compact';
  preProviderBudgetExceeded?: boolean;
}

/** Tools that mutate files — the file-edit counter counts their OK completions.
 * `bash` is included (review P2-5): bash can write files via redirect/tee/cp/mv
 * and its output gives no reliable way to distinguish read-only from mutating
 * invocations. Counting a successful bash call as a file-edit prevents false-THRASH
 * on bash-driven write loops where `filesEdited` would otherwise stay zero. */
const FILE_MUTATING_TOOLS = new Set(['write', 'edit', 'apply_patch', 'notebook_edit', 'multi_edit', 'bash']);

/** No-op result heuristics per tool: a completed-OK call that changed nothing. */
const NO_OP_PATTERNS: RegExp[] = [
  /\bno changes?\b/i,
  /\bnothing to (do|change|commit|update)\b/i,
  /\b0 results?\b/i,
  /\bno matches? found\b/i,
  /\bno files? found\b/i,
  /\balready up to date\b/i,
];

export function classifyToolOutcome(isError: boolean, result: string | undefined): ToolOutcome {
  if (isError) return 'error';
  const text = (result ?? '').trim();
  if (!text) return 'no_op';
  if (NO_OP_PATTERNS.some((re) => re.test(text))) return 'no_op';
  return 'ok';
}

export function isFileMutatingTool(toolName: string): boolean {
  return FILE_MUTATING_TOOLS.has(toolName.toLowerCase());
}

/** Accumulates one turn's signals; finalize() emits the record. */
export class TurnAccumulator {
  private toolCalls: ToolCallRecord[] = [];
  private filesEdited = 0;
  private loopGuardHits = 0;
  private ttftMs: number | null = null;
  private decodeTokensPerSec: number | null = null;
  private provider = '';

  recordTool(toolName: string, isError: boolean, result: string | undefined, durationMs: number): void {
    const outcome = classifyToolOutcome(isError, result);
    this.toolCalls.push({ name: toolName, outcome, durationMs });
    if (outcome === 'ok' && isFileMutatingTool(toolName)) this.filesEdited += 1;
  }

  recordPerf(perf: { provider: string; ttftMs: number | null; decodeTokensPerSec: number | null }): void {
    this.provider = perf.provider || this.provider;
    this.ttftMs = perf.ttftMs;
    this.decodeTokensPerSec = perf.decodeTokensPerSec;
  }

  recordLoopGuardHit(): void {
    this.loopGuardHits += 1;
  }

  finalize(meta: {
    runId: string;
    agent?: string;
    turnIndex: number;
    ts: number;
    model: string;
    inputTokens: number;
    outputTokens: number;
    timeOnTurnMs: number;
    promptTokenEstimate?: number;
    systemOverheadTokens?: number;
    messageTokens?: number;
    toolDefinitionTokens?: number;
    sourceKind?: 'heartbeat' | 'scheduled' | 'user' | 'unknown';
    compactionAction?: 'none' | 'compact';
    preProviderBudgetExceeded?: boolean;
  }): TurnTelemetryRecord {
    let toolOk = 0, toolError = 0, toolNoOp = 0;
    for (const c of this.toolCalls) {
      if (c.outcome === 'ok') toolOk += 1;
      else if (c.outcome === 'error') toolError += 1;
      else toolNoOp += 1;
    }
    return {
      runId: meta.runId,
      ...(meta.agent ? { agent: meta.agent } : {}),
      turnIndex: meta.turnIndex,
      ts: meta.ts,
      model: meta.model,
      provider: this.provider,
      toolCalls: this.toolCalls,
      toolOk,
      toolError,
      toolNoOp,
      filesEdited: this.filesEdited,
      inputTokens: meta.inputTokens,
      outputTokens: meta.outputTokens,
      ttftMs: this.ttftMs,
      decodeTokensPerSec: this.decodeTokensPerSec,
      timeOnTurnMs: meta.timeOnTurnMs,
      loopGuardHits: this.loopGuardHits,
      ...(meta.promptTokenEstimate !== undefined ? { promptTokenEstimate: meta.promptTokenEstimate } : {}),
      ...(meta.systemOverheadTokens !== undefined ? { systemOverheadTokens: meta.systemOverheadTokens } : {}),
      ...(meta.messageTokens !== undefined ? { messageTokens: meta.messageTokens } : {}),
      ...(meta.toolDefinitionTokens !== undefined ? { toolDefinitionTokens: meta.toolDefinitionTokens } : {}),
      ...(meta.sourceKind !== undefined ? { sourceKind: meta.sourceKind } : {}),
      ...(meta.compactionAction !== undefined ? { compactionAction: meta.compactionAction } : {}),
      ...(meta.preProviderBudgetExceeded !== undefined ? { preProviderBudgetExceeded: meta.preProviderBudgetExceeded } : {}),
    };
  }
}

/** A durable sink for finalized turn records. Implementations append-only. */
export interface TurnTelemetrySink {
  write(record: TurnTelemetryRecord): void;
}

/**
 * SCLI-31: consolidate ONE completed turn's signals into the rolling window +
 * durable sink. Shared by BOTH agent loops — the TUI loop (`agent/loop.ts`) and
 * the exec/`-p`/pipe loop (`runAgentWithPrompt` in `index.ts`) — so every live
 * run path writes telemetry from a single implementation (no drift). Pure: the
 * caller wraps it best-effort so a telemetry failure never breaks a turn.
 */
export function recordTurnTelemetry(args: {
  window: TurnTelemetryWindow;
  sink?: TurnTelemetrySink;
  result: {
    toolCalls?: Array<{ id: string; name: string }>;
    toolResults?: Array<{ toolUseId: string; isError?: boolean; content?: string; durationMs?: number }>;
    ttftMs?: number | null;
    decodeTokensPerSec?: number | null;
    inputTokens: number;
    outputTokens: number;
  };
  providerName: string;
  runId: string;
  agentLabel?: string;
  turnIndex: number;
  model: string;
  turnDurationMs: number;
  loopGuardHit?: boolean;
  promptBudget?: {
    promptTokenEstimate: number;
    systemOverheadTokens: number;
    messageTokens: number;
    toolDefinitionTokens: number;
    sourceKind: 'heartbeat' | 'scheduled' | 'user' | 'unknown';
  };
  compactionAction?: 'none' | 'compact';
  preProviderBudgetExceeded?: boolean;
}): void {
  const { window, sink, result } = args;
  const acc = new TurnAccumulator();
  const resultById = new Map((result.toolResults ?? []).map((r) => [r.toolUseId, r]));
  for (const tc of result.toolCalls ?? []) {
    const tr = resultById.get(tc.id);
    acc.recordTool(tc.name, !!tr?.isError, tr?.content, tr?.durationMs ?? 0);
  }
  acc.recordPerf({
    provider: args.providerName,
    ttftMs: result.ttftMs ?? null,
    decodeTokensPerSec: result.decodeTokensPerSec ?? null,
  });
  if (args.loopGuardHit) acc.recordLoopGuardHit();
  const rec = acc.finalize({
    runId: args.runId,
    ...(args.agentLabel ? { agent: args.agentLabel } : {}),
    turnIndex: args.turnIndex,
    ts: Date.now(),
    model: args.model,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    timeOnTurnMs: args.turnDurationMs,
    ...(args.promptBudget ?? {}),
    ...(args.compactionAction ? { compactionAction: args.compactionAction } : {}),
    ...(args.preProviderBudgetExceeded !== undefined ? { preProviderBudgetExceeded: args.preProviderBudgetExceeded } : {}),
  });
  window.push(rec);
  sink?.write(rec);
}

/**
 * Append-only JSONL sink. TUI → `~/.config/shizuha/turn-telemetry.jsonl`;
 * fleet agents → `~/.shizuha/claude-sessions/<agent>/turn-telemetry.jsonl`.
 * One line per turn; best-effort (telemetry never breaks a turn).
 */
export class JsonlTelemetrySink implements TurnTelemetrySink {
  constructor(
    private readonly filePath: string,
    private readonly fsImpl: {
      mkdirSync: (p: string, opts: { recursive: boolean }) => void;
      appendFileSync: (p: string, data: string) => void;
      dirname: (p: string) => string;
    },
  ) {}

  write(record: TurnTelemetryRecord): void {
    try {
      this.fsImpl.mkdirSync(this.fsImpl.dirname(this.filePath), { recursive: true });
      this.fsImpl.appendFileSync(this.filePath, JSON.stringify(record) + '\n');
    } catch {
      // best-effort: telemetry persistence must never break a turn
    }
  }
}

export function telemetryWindowSize(): number {
  const raw = process.env['SHIZUHA_TELEMETRY_WINDOW'];
  const parsed = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 50;
}

/** Bounded last-N rolling window of turn records (newest last). */
export class TurnTelemetryWindow {
  private records: TurnTelemetryRecord[] = [];
  private readonly capacity: number;

  constructor(capacity: number = telemetryWindowSize()) {
    this.capacity = Math.max(1, capacity);
  }

  push(record: TurnTelemetryRecord): void {
    this.records.push(record);
    if (this.records.length > this.capacity) {
      this.records.splice(0, this.records.length - this.capacity);
    }
  }

  /** Last `n` records (default = whole window), newest last. */
  query(n?: number): TurnTelemetryRecord[] {
    if (n == null || n >= this.records.length) return [...this.records];
    return this.records.slice(this.records.length - n);
  }

  size(): number {
    return this.records.length;
  }

  clear(): void {
    this.records = [];
  }
}
