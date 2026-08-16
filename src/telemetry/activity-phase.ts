/**
 * Live operator-facing activity phase for fleet agents.
 *
 * Coarse `state` stays `idle | working` so existing Hive / lease / grace
 * consumers keep working. Fine `phase` is what the Agents card animates:
 * thinking / responding / tool / idle.
 */

export const ACTIVITY_PHASES = ['idle', 'thinking', 'responding', 'tool'] as const;
export type ActivityPhase = (typeof ACTIVITY_PHASES)[number];

export type ActivityPhaseSnapshot = {
  state: 'idle' | 'working';
  phase: ActivityPhase;
  phase_since_ms: number;
  phase_for_ms: number;
  tool_name: string | null;
  tool_count: number;
  queue_depth?: number;
  last_activity_ms_ago: number;
  seconds_24h: Record<ActivityPhase, number>;
};

export type ActivityPhaseChange = {
  from: ActivityPhase;
  to: ActivityPhase;
  snapshot: ActivityPhaseSnapshot;
};

const PHASE_SET = new Set<string>(ACTIVITY_PHASES);

export function isActivityPhase(value: unknown): value is ActivityPhase {
  return typeof value === 'string' && PHASE_SET.has(value);
}

export class ActivityPhaseTracker {
  private phase: ActivityPhase = 'idle';
  private phaseSince = Date.now();
  private toolName: string | null = null;
  private toolCount = 0;
  private inflightTools = 0;
  private lastActivityAt = Date.now();
  private readonly seconds: Record<ActivityPhase, number> = {
    idle: 0,
    thinking: 0,
    responding: 0,
    tool: 0,
  };
  private readonly onChange?: (change: ActivityPhaseChange) => void;
  private readonly now: () => number;

  constructor(opts?: {
    onChange?: (change: ActivityPhaseChange) => void;
    now?: () => number;
  }) {
    this.onChange = opts?.onChange;
    this.now = opts?.now ?? Date.now;
    this.phaseSince = this.now();
    this.lastActivityAt = this.phaseSince;
  }

  get current(): ActivityPhase {
    return this.phase;
  }

  markThinking(): boolean {
    return this.setPhase('thinking');
  }

  markResponding(): boolean {
    return this.setPhase('responding');
  }

  markTool(name?: string | null): boolean {
    this.inflightTools += 1;
    this.toolCount += 1;
    return this.setPhase('tool', { toolName: name ?? this.toolName });
  }

  endTool(): boolean {
    this.inflightTools = Math.max(0, this.inflightTools - 1);
    if (this.inflightTools > 0) {
      return this.setPhase('tool');
    }
    this.toolName = null;
    return this.setPhase('thinking');
  }

  markIdle(): boolean {
    this.inflightTools = 0;
    this.toolName = null;
    return this.setPhase('idle');
  }

  setPhase(phase: ActivityPhase, detail?: { toolName?: string | null }): boolean {
    const now = this.now();
    if (detail?.toolName) this.toolName = detail.toolName;
    if (phase === this.phase) {
      if (phase !== 'idle') this.lastActivityAt = now;
      return false;
    }
    const elapsedSec = Math.max(0, (now - this.phaseSince) / 1000);
    this.seconds[this.phase] += elapsedSec;
    const from = this.phase;
    this.phase = phase;
    this.phaseSince = now;
    if (phase !== 'idle') this.lastActivityAt = now;
    if (phase !== 'tool') this.toolName = detail?.toolName ?? null;
    const snapshot = this.snapshot();
    this.onChange?.({ from, to: phase, snapshot });
    return true;
  }

  snapshot(extra?: {
    queueDepth?: number;
    lastActivityAt?: number;
  }): ActivityPhaseSnapshot {
    const now = this.now();
    const lastActivityAt = extra?.lastActivityAt ?? this.lastActivityAt;
    const seconds = { ...this.seconds };
    seconds[this.phase] += Math.max(0, (now - this.phaseSince) / 1000);
    return {
      state: this.phase === 'idle' ? 'idle' : 'working',
      phase: this.phase,
      phase_since_ms: this.phaseSince,
      phase_for_ms: Math.max(0, now - this.phaseSince),
      tool_name: this.phase === 'tool' ? this.toolName : null,
      tool_count: this.toolCount,
      ...(extra?.queueDepth != null ? { queue_depth: extra.queueDepth } : {}),
      last_activity_ms_ago: Math.max(0, now - lastActivityAt),
      seconds_24h: {
        idle: roundSeconds(seconds.idle),
        thinking: roundSeconds(seconds.thinking),
        responding: roundSeconds(seconds.responding),
        tool: roundSeconds(seconds.tool),
      },
    };
  }
}

export function applyAgentEventToPhase(
  tracker: ActivityPhaseTracker,
  event: { type?: string; toolName?: string; data?: { tool?: string } },
): boolean {
  switch (event.type) {
    case 'turn_start':
    case 'thinking':
    case 'reasoning':
    case 'reasoning_text':
      return tracker.markThinking();
    case 'content':
    case 'token_progress':
      return tracker.markResponding();
    case 'tool_start':
      return tracker.markTool(event.toolName ?? event.data?.tool ?? null);
    case 'tool_complete':
      return tracker.endTool();
    case 'complete':
      return tracker.markIdle();
    default:
      return false;
  }
}

/** Reconcile the tracker with the process busy latch, then emit a card payload. */
export function buildActivityTelemetry(
  tracker: ActivityPhaseTracker,
  opts: {
    busy: boolean;
    queueDepth?: number;
    lastActivityAt?: number;
    extra?: Record<string, unknown>;
  },
): Record<string, unknown> {
  if (!opts.busy) {
    tracker.markIdle();
  } else if (tracker.current === 'idle') {
    tracker.markThinking();
  }
  return {
    ...tracker.snapshot({
      queueDepth: opts.queueDepth,
      lastActivityAt: opts.lastActivityAt,
    }),
    ...(opts.extra ?? {}),
  };
}

export function createTelemetryFlusher(
  emit: () => void,
  debounceMs = 150,
): { now: () => void; soon: () => void; stop: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const now = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    emit();
  };
  const soon = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      emit();
    }, debounceMs);
    timer.unref?.();
  };
  const stop = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
  return { now, soon, stop };
}

function roundSeconds(value: number): number {
  return Number(value.toFixed(1));
}
