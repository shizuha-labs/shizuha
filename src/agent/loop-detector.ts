import { logger } from '../utils/logger.js';
import { isPulseGetMyWorkToolName } from '../shared/heartbeat-outcome.js';

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

/** Valid catalog names; anything else is wrap-up / parser junk. */
const VALID_TOOL_NAME = /^(mcp__)?[A-Za-z][A-Za-z0-9_-]*(__[A-Za-z0-9_-]+)*$/;

export function canonicalToolName(toolName: string): string {
  const n = (toolName || '').trim();
  if (!n || n.includes('()') || n.includes('{') || n.includes('=') || /\s/.test(n)) {
    return 'garbled_tool';
  }
  if (!VALID_TOOL_NAME.test(n)) return 'garbled_tool';
  // audit_audit_audit_audit / message_message_user wrap-up
  if (/^([A-Za-z0-9]+)(_\1){2,}/.test(n)) return 'garbled_tool';
  return n;
}

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
 * 2. **Ping-pong**: Alternating between two (tool, input) signatures
 *    (read→write, or same tool with two args: get_task A→get_task B→A→B).
 *    Same-tool two-arg ABAB was invisible when ping-pong required different
 *    tool *names* (revi 2026-08-22: pulse_get_task HIVE-1953 / PLS-986).
 * 3. **Probe loop**: N consecutive `bash` calls running `python3 -c "..."` (or
 *    similar inline probes) with no intervening file write/edit. Observed in
 *    M2.5 fail logs — model spelunks via bash probes for 13+ turns instead of
 *    fixing the file. Coaching nudge tells it to apply a fix to the file now.
 */
export class LoopDetector {
  private history: CallRecord[] = [];
  private config: LoopDetectorConfig;
  // SCLI-6xx (mio 2026-09-19, live): probe/text oscillation defeats the
  // trailing-probe streak — each nudge produces a mixed turn that resets the
  // streak below probeLoopBreak, so the detector nudges forever while the
  // context grows ~1K tokens per cycle and long-context degradation deepens
  // (the very regime that causes the probing). Track consecutive nudges
  // without an intervening write; escalate to break after 3.
  private probeNudgeStreak = 0;

  constructor(config?: Partial<LoopDetectorConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Record a tool call and check for loops.
   * Returns 'ok', 'warning', 'probe-warning', or 'break'.
   */
  record(toolName: string, input: Record<string, unknown>): 'ok' | 'warning' | 'probe-warning' | 'break' {
    // Ryo 2026-09-11 gen35: after prefetch, GLM still ping-ponged
    // pulse_get_my_work `{}` vs `{limit:40}`. Those are the same listing.
    // Hash them as one signature so exact-repeat break fires at 5, not
    // ping-pong at 10. get_task / transition args stay distinct.
    // GLM wrap-up emits a new garbled name every turn
    // (`message_user()()={"content":"pong"}audit_user…`). Those must
    // count as the SAME tool or exact-repeat never fires (Shion 2026-09-15).
    const canonicalName = canonicalToolName(toolName);
    const hashedInput = isPulseGetMyWorkToolName(canonicalName) ? {} : input;
    const inputHash = simpleHash(JSON.stringify(hashedInput));
    const { isProbe, isWrite } = classifyCall(canonicalName, input);
    if (isWrite) this.probeNudgeStreak = 0;
    this.history.push({ toolName: canonicalName, inputHash, isProbe, isWrite });

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
      this.probeNudgeStreak += 1;
      if (this.probeNudgeStreak >= 3) {
        logger.warn(
          { probeStreak, probeNudgeStreak: this.probeNudgeStreak },
          'Probe loop: 3 nudges without a write — breaking (nudge-forever guard, SCLI-6xx)',
        );
        return 'break';
      }
      logger.info({ probeStreak, probeNudgeStreak: this.probeNudgeStreak }, 'Probe loop detected: nudging');
      return 'probe-warning';
    }
    this.probeNudgeStreak = 0;

    return 'ok';
  }

  /** Reset the history (e.g., on new user message) */
  reset(): void {
    this.probeNudgeStreak = 0;
    this.history = [];
  }

  /**
   * PLAT-8991: reset the history when a turn made no write-class calls.
   *
   * The process-lifetime detector deliberately persists across heartbeat turns
   * so ABAB fetch loops accumulate — but that design assumed hours-scale beat
   * cadence. At the 90s fleet idle cadence, contract-correct drained beats
   * accumulate identical `pulse_get_my_work` probes (~40/hour) and
   * false-positive the probe-streak. A heartbeat turn with no write-class
   * calls is a clean boundary: only within-turn runaways (the ABAB class this
   * persistence exists for) still accumulate, because any such loop re-manifests
   * inside the next turn and re-crosses the threshold there.
   */
  resetIfNoWrites(toolCalls: ReadonlyArray<{ name?: string; input?: unknown }>): void {
    for (const call of toolCalls) {
      if (!call?.name) continue;
      const input = call.input && typeof call.input === 'object' && !Array.isArray(call.input)
        ? (call.input as Record<string, unknown>)
        : {};
      const { isWrite } = classifyCall(canonicalToolName(call.name), input);
      if (isWrite) return; // dirty beat — keep the streak
    }
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

    // Last two must differ in tool *or* input. Identical signatures are
    // exact-repeat. Same tool + two alternating inputs is ping-pong.
    if (a.toolName === b.toolName && a.inputHash === b.inputHash) return 0;

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
