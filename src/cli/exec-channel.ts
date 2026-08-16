/**
 * SCLI-410 — the ONE shared channel contract for non-interactive `shizuha -p`
 * and `shizuha exec`. Both entrypoints render every AgentEvent through this
 * single `writeExecEvent` (no divergent quiet paths).
 *
 * stdout carries the result stream (and the structured NDJSON stream under
 * `--json`); stderr is reserved for run-level diagnostics and is BYTE-EMPTY on
 * a successful run. Model reasoning is not a diagnostic channel — suppressed by
 * default, never written to default stderr. Tool progress is not a diagnostic
 * either: it is buffered and surfaces on stderr only if the run ultimately
 * fails, so a successful run stays byte-empty while a failing run still yields
 * an actionable diagnostic (the quiet-success vs disabled-stderr discriminator
 * required by the SCLI-410 acceptance).
 */

import type { AgentEvent } from '../events/types.js';
import { toNDJSON } from '../events/stream.js';

export function truncateInline(value: string, max = 220): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 3)}...`;
}

export function shellQuoteSingle(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function summarizeToolInput(input: Record<string, unknown>, maxKeys = 4): string {
  const entries = Object.entries(input);
  if (entries.length === 0) return '';
  const shown = entries.slice(0, maxKeys).map(([key, value]) => {
    if (typeof value === 'string') return [key, truncateInline(value, 80)];
    if (typeof value === 'number' || typeof value === 'boolean' || value == null) return [key, value];
    if (Array.isArray(value)) return [key, `[${value.length} items]`];
    return [key, '[object]'];
  });
  const payload = Object.fromEntries(shown);
  const json = JSON.stringify(payload);
  const suffix = entries.length > maxKeys ? ' ...' : '';
  return `${truncateInline(json, 220)}${suffix}`;
}

export function formatToolInvocation(toolName: string, input: Record<string, unknown>): string {
  if (toolName === 'bash') {
    const command = typeof input.command === 'string' ? input.command : '';
    if (!command) return 'bash';
    return `/bin/bash -lc ${shellQuoteSingle(truncateInline(command, 260))}`;
  }
  const summarized = summarizeToolInput(input);
  return summarized ? `${toolName} ${summarized}` : toolName;
}

export interface ExecAcc {
  finalText: string;
  failed: boolean;
  bufferedDiags: string[];
}

export function writeExecEvent(event: AgentEvent, isJSON: boolean, acc: ExecAcc): void {
  // Run-level failure handling is mode-independent: an `error` record means the
  // turn loop aborted — set a nonzero exit, flush buffered tool diagnostics and
  // surface the actionable error on stderr. (The loop always yields a final
  // `complete` afterwards, so this explicit exit-code signal is what makes a
  // failing subprocess exit nonzero.)
  if (event.type === 'error') {
    acc.failed = true;
    process.exitCode = 1;
    if (acc.bufferedDiags.length) {
      process.stderr.write(acc.bufferedDiags.join(''));
      acc.bufferedDiags = [];
    }
    process.stderr.write(`\n[Error: ${event.error}]\n`);
  }

  if (isJSON) {
    // Structured stream: every raw event on stdout; consumers parse the `error`
    // record. Only diagnostics ever touch stderr (and then only on failure).
    process.stdout.write(toNDJSON(event));
    return;
  }

  switch (event.type) {
    case 'content':
      process.stdout.write(event.text);
      acc.finalText += event.text;
      break;
    case 'reasoning_text':
      // Model-internal thought, not a diagnostic channel. Absent by default;
      // never on default stderr (SCLI-410).
      break;
    case 'tool_start':
      // Progress, not output and not a diagnostic. Buffered; flushed to stderr
      // only on a failed run.
      acc.bufferedDiags.push(`\n[Tool] ${formatToolInvocation(event.toolName, event.input)}`);
      break;
    case 'tool_complete':
      if (event.isError) {
        acc.bufferedDiags.push(`\n[Tool error: ${event.result.slice(0, 200)}]`);
      }
      break;
    case 'complete':
      // Failure diagnostics already flushed above; on success a clean trailing
      // newline after the result. Success writes nothing to stderr.
      if (!acc.failed && acc.finalText) process.stdout.write('\n');
      break;
  }
}
