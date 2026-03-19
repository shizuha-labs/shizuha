import { logger } from '../utils/logger.js';

export interface LoopDetectorConfig {
  /** Number of consecutive identical tool calls before warning (default: 3) */
  warningThreshold: number;
  /** Number of consecutive identical calls before hard stop (default: 5) */
  breakThreshold: number;
}

const DEFAULT_CONFIG: LoopDetectorConfig = {
  warningThreshold: 3,
  breakThreshold: 5,
};

interface CallRecord {
  toolName: string;
  inputHash: string;
}

/**
 * Detects when the agent is stuck in a loop calling the same tool repeatedly.
 *
 * Detection patterns:
 * 1. **Exact repeat**: Same tool + same input N times in a row
 * 2. **Ping-pong**: Alternating between two tools (A→B→A→B)
 */
export class LoopDetector {
  private history: CallRecord[] = [];
  private config: LoopDetectorConfig;

  constructor(config?: Partial<LoopDetectorConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Record a tool call and check for loops.
   * Returns 'ok', 'warning', or 'break'.
   */
  record(toolName: string, input: Record<string, unknown>): 'ok' | 'warning' | 'break' {
    const inputHash = simpleHash(JSON.stringify(input));
    this.history.push({ toolName, inputHash });

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

    return 'ok';
  }

  /** Reset the history (e.g., on new user message) */
  reset(): void {
    this.history = [];
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
