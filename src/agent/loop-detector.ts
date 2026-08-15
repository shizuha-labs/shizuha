import { logger } from '../utils/logger.js';

export interface LoopDetectorConfig {
  /** Number of consecutive identical tool calls before warning (default: 3) */
  warningThreshold: number;
  /** Number of consecutive identical calls before hard stop (default: 5) */
  breakThreshold: number;
  /** Consecutive bash probes without write/edit before coaching nudge (default: 5) */
  probeLoopWarning: number;
  /** Consecutive bash probes without write/edit before break (default: 8) */
  probeLoopBreak: number;
}

const DEFAULT_CONFIG: LoopDetectorConfig = {
  warningThreshold: 3,
  breakThreshold: 5,
  probeLoopWarning: 5,
  probeLoopBreak: 8,
};

interface CallRecord {
  toolName: string;
  inputHash: string;
  /** True when the call is a bash invocation containing inline python/sh probe code */
  isProbe: boolean;
  /** True when the call mutates a file (write/edit/notebook_edit/apply_patch) */
  isWrite: boolean;
}

/** Bash commands that look like exploratory inline probes rather than real work. */
const PROBE_PATTERNS = [
  /\bpython3?\s+-c\b/,
  /\bnode\s+-e\b/,
  /\bperl\s+-e\b/,
  /\bruby\s+-e\b/,
];

/** Tool names that count as actual file writes. */
const WRITE_TOOL_NAMES = new Set([
  'write', 'edit', 'notebook_edit', 'apply_patch', 'multi_edit',
]);

function classifyCall(toolName: string, input: Record<string, unknown>): { isProbe: boolean; isWrite: boolean } {
  const isWrite = WRITE_TOOL_NAMES.has(toolName);
  let isProbe = false;
  if (toolName === 'bash') {
    const cmd = typeof input['command'] === 'string' ? input['command'] : '';
    isProbe = PROBE_PATTERNS.some((re) => re.test(cmd));
  }
  return { isProbe, isWrite };
}

/**
 * Detects when the agent is stuck in a loop calling the same tool repeatedly.
 *
 * Detection patterns:
 * 1. **Exact repeat**: Same tool + same input N times in a row
 * 2. **Ping-pong**: Alternating between two tools (A→B→A→B)
 * 3. **Probe loop**: N consecutive `bash` calls running `python3 -c "..."` (or
 *    similar inline probes) with no intervening file write/edit. Observed in
 *    M2.5 fail logs — model spelunks via bash probes for 13+ turns instead of
 *    fixing the file. Coaching nudge tells it to apply a fix to the file now.
 */
export class LoopDetector {
  private history: CallRecord[] = [];
  private config: LoopDetectorConfig;

  constructor(config?: Partial<LoopDetectorConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Record a tool call and check for loops.
   * Returns 'ok', 'warning', 'probe-warning', or 'break'.
   */
  record(toolName: string, input: Record<string, unknown>): 'ok' | 'warning' | 'probe-warning' | 'break' {
    const inputHash = simpleHash(JSON.stringify(input));
    const { isProbe, isWrite } = classifyCall(toolName, input);
    this.history.push({ toolName, inputHash, isProbe, isWrite });

    // Keep only last 20 calls
    if (this.history.length > 20) {
      this.history = this.history.slice(-20);
    }

    // Check exact repeat pattern
    const repeatCount = this.countTrailingRepeats();
    if (repeatCount >= this.config.breakThreshold) {
      logger.warn({ toolName, repeatCount }, 'Loop detected: breaking');
      return 'break';
    }
    if (repeatCount >= this.config.warningThreshold) {
      logger.info({ toolName, repeatCount }, 'Loop detected: warning');
      return 'warning';
    }

    // Check ping-pong pattern (A→B→A→B)
    const pingPongCount = this.countPingPong();
    if (pingPongCount >= this.config.breakThreshold) {
      logger.warn({ count: pingPongCount }, 'Ping-pong loop detected: breaking');
      return 'break';
    }
    if (pingPongCount >= this.config.warningThreshold) {
      logger.info({ count: pingPongCount }, 'Ping-pong loop detected: warning');
      return 'warning';
    }

    // Check probe-loop pattern (bash probes piling up without any file write)
    const probeStreak = this.countTrailingProbes();
    if (probeStreak >= this.config.probeLoopBreak) {
      logger.warn({ probeStreak }, 'Probe loop detected: breaking');
      return 'break';
    }
    if (probeStreak >= this.config.probeLoopWarning) {
      logger.info({ probeStreak }, 'Probe loop detected: nudging');
      return 'probe-warning';
    }

    return 'ok';
  }

  /** Reset the history (e.g., on new user message) */
  reset(): void {
    this.history = [];
  }

  private countTrailingProbes(): number {
    let count = 0;
    for (let i = this.history.length - 1; i >= 0; i--) {
      const rec = this.history[i]!;
      if (rec.isWrite) break;        // any write resets the streak
      if (rec.isProbe) count++;
      else if (count > 0) break;      // non-probe non-write breaks the streak only if we'd already started
    }
    return count;
  }

  private countTrailingRepeats(): number {
    if (this.history.length === 0) return 0;
    const last = this.history[this.history.length - 1]!;
    let count = 0;
    for (let i = this.history.length - 1; i >= 0; i--) {
      const rec = this.history[i]!;
      if (rec.toolName === last.toolName && rec.inputHash === last.inputHash) {
        count++;
      } else {
        break;
      }
    }
    return count;
  }

  private countPingPong(): number {
    if (this.history.length < 4) return 0;
    const len = this.history.length;
    const a = this.history[len - 2]!;
    const b = this.history[len - 1]!;

    // Check if last two are different
    if (a.toolName === b.toolName) return 0;

    let count = 0;
    for (let i = len - 1; i >= 1; i -= 2) {
      const cur = this.history[i]!;
      const prev = this.history[i - 1]!;
      if (cur.toolName === b.toolName && cur.inputHash === b.inputHash &&
          prev.toolName === a.toolName && prev.inputHash === a.inputHash) {
        count++;
      } else {
        break;
      }
    }
    return count;
  }
}

/** Simple string hash for input comparison */
function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0; // Convert to 32-bit integer
  }
  return hash.toString(36);
}
