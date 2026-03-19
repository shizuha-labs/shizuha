/**
 * Security Audit Trail — per-tool invocation logging.
 *
 * GAP C: OpenClaw parity — every tool call is logged to an append-only
 * NDJSON audit log with timing, user, agent, and risk flags.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

// ── Types ──

export interface AuditEntry {
  id: string;
  timestamp: string;
  agent: string;
  user?: string;
  tool: string;
  inputSummary: string;
  resultSummary?: string;
  durationMs?: number;
  riskFlags: string[];
  phase: 'before' | 'after' | 'error';
}

// ── Dangerous operation patterns ──

const DANGEROUS_PATTERNS: Array<{ pattern: RegExp; flag: string }> = [
  { pattern: /rm\s+(-rf?|--recursive)\s/i, flag: 'destructive-delete' },
  { pattern: /curl\s.*https?:\/\/(?!127\.0\.0\.1|localhost)/i, flag: 'external-network' },
  { pattern: /wget\s/i, flag: 'external-network' },
  { pattern: /chmod\s+[0-7]*7[0-7]*\s/i, flag: 'world-writable' },
  { pattern: /eval\s*\(/i, flag: 'eval' },
  { pattern: /DROP\s+(TABLE|DATABASE)/i, flag: 'destructive-sql' },
  { pattern: /DELETE\s+FROM\s+\w+\s*;?\s*$/i, flag: 'bulk-delete-sql' },
  { pattern: /\.env|credentials|secret|private[_-]?key/i, flag: 'sensitive-file-access' },
  { pattern: /sudo\s/i, flag: 'privilege-escalation' },
  { pattern: /passwd|shadow|authorized_keys/i, flag: 'auth-file-access' },
];

/**
 * Detect potentially dangerous operations in tool input.
 */
function detectRisks(toolName: string, input: string): string[] {
  const flags: string[] = [];
  for (const { pattern, flag } of DANGEROUS_PATTERNS) {
    if (pattern.test(input)) flags.push(flag);
  }
  // Always flag bash/shell tools
  if (toolName === 'bash' || toolName === 'shell') {
    flags.push('shell-execution');
  }
  return flags;
}

/**
 * Summarize input (truncate long strings, redact obvious secrets).
 */
function summarize(input: unknown, maxLen = 500): string {
  let text: string;
  if (typeof input === 'string') {
    text = input;
  } else {
    try {
      text = JSON.stringify(input);
    } catch {
      text = String(input);
    }
  }
  // Redact things that look like tokens/keys
  text = text.replace(/(?:Bearer |token[=:]|key[=:]|secret[=:])\s*[A-Za-z0-9_\-\.]{20,}/gi, '[REDACTED]');
  if (text.length > maxLen) return text.slice(0, maxLen) + '...';
  return text;
}

// ── AuditLogger ──

export class AuditLogger {
  private logPath: string;
  private stream: fs.WriteStream | null = null;

  constructor(workspace: string) {
    this.logPath = path.join(workspace, '.audit-log.jsonl');
  }

  private getStream(): fs.WriteStream {
    if (!this.stream || this.stream.destroyed) {
      const dir = path.dirname(this.logPath);
      fs.mkdirSync(dir, { recursive: true });
      this.stream = fs.createWriteStream(this.logPath, { flags: 'a' });
    }
    return this.stream;
  }

  /**
   * Log a tool invocation before execution.
   * Returns the entry ID for pairing with the after/error log.
   */
  logBefore(agent: string, tool: string, input: unknown, user?: string): string {
    const id = crypto.randomUUID();
    const inputStr = summarize(input);
    const entry: AuditEntry = {
      id,
      timestamp: new Date().toISOString(),
      agent,
      user,
      tool,
      inputSummary: inputStr,
      riskFlags: detectRisks(tool, inputStr),
      phase: 'before',
    };
    this.write(entry);
    return id;
  }

  /**
   * Log tool completion.
   */
  logAfter(id: string, agent: string, tool: string, result: unknown, durationMs: number): void {
    const entry: AuditEntry = {
      id,
      timestamp: new Date().toISOString(),
      agent,
      tool,
      inputSummary: '',
      resultSummary: summarize(result, 300),
      durationMs,
      riskFlags: [],
      phase: 'after',
    };
    this.write(entry);
  }

  /**
   * Log tool error.
   */
  logError(id: string, agent: string, tool: string, error: string, durationMs: number): void {
    const entry: AuditEntry = {
      id,
      timestamp: new Date().toISOString(),
      agent,
      tool,
      inputSummary: '',
      resultSummary: `ERROR: ${error.slice(0, 300)}`,
      durationMs,
      riskFlags: ['error'],
      phase: 'error',
    };
    this.write(entry);
  }

  /**
   * Log an allowlist change event.
   */
  logAllowlistChange(agent: string, action: 'add' | 'remove', tool: string): void {
    const entry: AuditEntry = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      agent,
      tool: `allowlist:${action}`,
      inputSummary: tool,
      riskFlags: ['allowlist-change'],
      phase: 'after',
    };
    this.write(entry);
  }

  /**
   * Query the audit log (tail N entries, optionally filtered).
   */
  query(opts: { limit?: number; tool?: string; agent?: string; riskOnly?: boolean }): AuditEntry[] {
    const { limit = 50, tool, agent, riskOnly } = opts;
    try {
      const raw = fs.readFileSync(this.logPath, 'utf-8');
      const lines = raw.trim().split('\n').filter(Boolean);
      const entries: AuditEntry[] = [];
      // Read from end for efficiency
      for (let i = lines.length - 1; i >= 0 && entries.length < limit * 2; i--) {
        try {
          const entry = JSON.parse(lines[i]!) as AuditEntry;
          if (tool && entry.tool !== tool) continue;
          if (agent && entry.agent !== agent) continue;
          if (riskOnly && entry.riskFlags.length === 0) continue;
          entries.push(entry);
        } catch { continue; }
      }
      return entries.slice(0, limit).reverse();
    } catch {
      return [];
    }
  }

  private write(entry: AuditEntry): void {
    try {
      const line = JSON.stringify(entry) + '\n';
      this.getStream().write(line);
    } catch {
      // Non-fatal — audit logging should never break the agent
    }
  }

  close(): void {
    this.stream?.end();
    this.stream = null;
  }
}
