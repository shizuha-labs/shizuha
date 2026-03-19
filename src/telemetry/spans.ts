/**
 * Lightweight span tracker — structured JSON logging for observability.
 *
 * GAP F: OpenClaw parity — no OTEL SDK dependency, just structured NDJSON.
 * Tracks tool calls, LLM turns, compaction, and channel delivery.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

// ── Types ──

export interface Span {
  spanId: string;
  traceId: string;
  parentSpanId?: string;
  name: string;
  startTime: string;
  startMs: number;
  endTime?: string;
  durationMs?: number;
  status: 'ok' | 'error' | 'running';
  metadata: Record<string, unknown>;
  result?: Record<string, unknown>;
}

// ── SpanTracker ──

export class SpanTracker {
  private logPath: string;
  private stream: fs.WriteStream | null = null;
  private activeSpans = new Map<string, Span>();
  private traceId: string;

  constructor(workspace: string, traceId?: string) {
    this.logPath = path.join(workspace, '.telemetry.jsonl');
    this.traceId = traceId || crypto.randomUUID();
  }

  /**
   * Start a new span. Returns the spanId for ending it later.
   */
  startSpan(name: string, metadata: Record<string, unknown> = {}, parentSpanId?: string): string {
    const spanId = crypto.randomUUID().slice(0, 16);
    const span: Span = {
      spanId,
      traceId: this.traceId,
      parentSpanId,
      name,
      startTime: new Date().toISOString(),
      startMs: Date.now(),
      status: 'running',
      metadata,
    };
    this.activeSpans.set(spanId, span);
    return spanId;
  }

  /**
   * End a span with a result. Logs the completed span to disk.
   */
  endSpan(spanId: string, result?: Record<string, unknown>, status: 'ok' | 'error' = 'ok'): void {
    const span = this.activeSpans.get(spanId);
    if (!span) return;

    span.endTime = new Date().toISOString();
    span.durationMs = Date.now() - span.startMs;
    span.status = status;
    if (result) span.result = result;

    this.activeSpans.delete(spanId);
    this.write(span);
  }

  /**
   * Convenience: trace a function, returning its result.
   */
  async trace<T>(
    name: string,
    metadata: Record<string, unknown>,
    fn: () => Promise<T>,
    parentSpanId?: string,
  ): Promise<T> {
    const spanId = this.startSpan(name, metadata, parentSpanId);
    try {
      const result = await fn();
      this.endSpan(spanId, { success: true }, 'ok');
      return result;
    } catch (err) {
      this.endSpan(spanId, { error: (err as Error).message }, 'error');
      throw err;
    }
  }

  /**
   * Get all currently active (running) spans.
   */
  activeSpanCount(): number {
    return this.activeSpans.size;
  }

  /**
   * Query recent spans from the log file.
   */
  queryRecent(limit = 50): Span[] {
    try {
      const raw = fs.readFileSync(this.logPath, 'utf-8');
      const lines = raw.trim().split('\n').filter(Boolean);
      const spans: Span[] = [];
      for (let i = lines.length - 1; i >= 0 && spans.length < limit; i--) {
        try {
          spans.push(JSON.parse(lines[i]!) as Span);
        } catch { continue; }
      }
      return spans.reverse();
    } catch {
      return [];
    }
  }

  private getStream(): fs.WriteStream {
    if (!this.stream || this.stream.destroyed) {
      const dir = path.dirname(this.logPath);
      fs.mkdirSync(dir, { recursive: true });
      this.stream = fs.createWriteStream(this.logPath, { flags: 'a' });
    }
    return this.stream;
  }

  private write(span: Span): void {
    try {
      const line = JSON.stringify(span) + '\n';
      this.getStream().write(line);
    } catch {
      // Non-fatal — telemetry should never break the agent
    }
  }

  close(): void {
    this.stream?.end();
    this.stream = null;
  }
}
