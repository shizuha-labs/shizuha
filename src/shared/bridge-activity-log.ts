/**
 * HIVE-609: bridge agents (claude-bridge, codex-bridge) must write their tool
 * activity to `.shizuha/.audit-log.jsonl` — the file Hive's per-agent Live-activity
 * feed reads. Previously only the native gateway wrote it, so every bridge agent's
 * feed froze at whatever the gateway/CLI last wrote (operator saw a live, working
 * agent as "Last active 11h ago"). This appends one JSONL entry per tool event in
 * the exact schema the daemon's activity reader parses
 * (dashboard.ts parseRuntimeWorkspaceActivity): {id, timestamp, agent, tool,
 * inputSummary|resultSummary, phase}.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const SECRET_RE = /(?:Bearer |token[=:]|key[=:]|secret[=:])\s*[A-Za-z0-9_\-.]{20,}/gi;

function summarize(input: unknown, maxLen = 500): string {
  let text: string;
  if (typeof input === 'string') text = input;
  else { try { text = JSON.stringify(input); } catch { text = String(input); } }
  text = text.replace(SECRET_RE, '[REDACTED]');
  return text.length > maxLen ? text.slice(0, maxLen) + '...' : text;
}

export class BridgeActivityLog {
  private auditPath: string;
  private agent: string;

  /** @param shizuhaHome the agent's `.shizuha` dir (e.g. /home/agent/.shizuha) */
  constructor(shizuhaHome: string, agentName: string) {
    this.auditPath = path.join(shizuhaHome, '.audit-log.jsonl');
    this.agent = agentName || 'agent';
  }

  private append(entry: Record<string, unknown>): void {
    try {
      fs.mkdirSync(path.dirname(this.auditPath), { recursive: true });
      fs.appendFileSync(this.auditPath, JSON.stringify(entry) + '\n');
    } catch {
      /* activity logging is best-effort — never break a turn on a write error */
    }
  }

  /** Log a tool invocation start. Returns an id to pair with toolResult. */
  toolCall(tool: string, input: unknown): string {
    const id = crypto.randomUUID();
    this.append({
      id, timestamp: new Date().toISOString(), agent: this.agent,
      tool: tool || 'tool', inputSummary: summarize(input), phase: 'before',
    });
    return id;
  }

  /** Log a tool completion (or, with isError, a failure). */
  toolResult(id: string, tool: string, result: unknown, isError = false, durationMs?: number): void {
    this.append({
      id: id || crypto.randomUUID(), timestamp: new Date().toISOString(), agent: this.agent,
      tool: tool || 'tool', resultSummary: summarize(result, 300),
      phase: isError ? 'error' : 'after', durationMs,
    });
  }
}

/** Resolve the agent's `.shizuha` home from the bridge's HOME resolution. */
export function shizuhaHomeDir(): string {
  const isRoot = (process.env['USER'] ?? '') === 'root' || process.getuid?.() === 0;
  const home = isRoot ? '/home/agent' : (process.env['HOME'] ?? '/root');
  return path.join(home, '.shizuha');
}
