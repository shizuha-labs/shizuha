import { z } from 'zod';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { glob as globFn } from 'glob';
import type { ToolHandler, ToolContext, ToolResult } from '../types.js';

const execFileAsync = promisify(execFile);

const SEARCH_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 5 * 1024 * 1024;
/** Hard cap on what we return to the model (rg --max-count is PER FILE, so
 *  a broad pattern across a monorepo can still produce 100s of KB / MB).
 *  537KB tool_result blobs have blown Codex/ChatGPT context mid-session. */
const MAX_RESULT_CHARS = 40_000;
const MAX_RESULT_LINES = 200;

function formatGrepMatches(stdout: string): string {
  let lines = stdout.trim().split('\n').filter((l) => l.length > 0);
  if (lines.length === 0) return 'No matches found.';
  let truncated = false;
  const totalFound = lines.length;
  if (lines.length > MAX_RESULT_LINES) {
    lines = lines.slice(0, MAX_RESULT_LINES);
    truncated = true;
  }
  let body = lines.join('\n');
  if (body.length > MAX_RESULT_CHARS) {
    body = `${body.slice(0, MAX_RESULT_CHARS)}\n…`;
    truncated = true;
  }
  const header = truncated
    ? `${lines.length} of ${totalFound}+ matches (truncated — narrow path/pattern/glob):\n`
    : `${lines.length} matches:\n`;
  const note = truncated
    ? '\n(note: grep output capped to protect the context window; re-run with a tighter path or pattern)'
    : '';
  return `${header}${body}${note}`;
}
/** jsGrep is the last-resort fallback: hard wall-clock budget so it can never wedge the turn. */
const JS_GREP_DEADLINE_MS = 20_000;
const JS_GREP_MAX_FILES = 20_000;

type ExecFailure = 'no-match' | 'timeout' | 'output-overflow' | 'aborted' | 'not-runnable';

/**
 * SCLI: a killed search (timeout/maxBuffer/abort) is NOT a broken binary. Only
 * spawn-level failures (ENOENT/EACCES/exec-format) may cascade to the next
 * fallback — a search that was too big for rg is guaranteed to be worse for
 * system grep and catastrophic for the pure-JS scanner (the /home-wide grep
 * that wedged a TUI at 100% CPU for 17+ minutes).
 */
export function classifyExecError(err: unknown): ExecFailure {
  const e = err as { code?: number | string; killed?: boolean; signal?: string };
  if (e.code === 1) return 'no-match';
  if (e.code === 'ABORT_ERR') return 'aborted';
  if (e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return 'output-overflow';
  if (e.killed || e.signal) return 'timeout';
  return 'not-runnable';
}

/** Salvage whatever the killed search already found; otherwise tell the model how to narrow. */
function timeoutResult(kind: 'timeout' | 'output-overflow', err: unknown, target: string): ToolResult {
  const partial = ((err as { stdout?: string }).stdout ?? '').trim();
  const why = kind === 'timeout'
    ? `Search timed out after ${SEARCH_TIMEOUT_MS / 1000}s`
    : 'Search produced too much output';
  const advice = `Narrow it: search a specific subdirectory instead of "${target}", add a glob filter (e.g. "*.ts"), or use a more specific pattern.`;
  if (partial) {
    const lines = partial.split('\n');
    return {
      toolUseId: '',
      content: `${why} in ${target}. Partial results (${lines.length} lines) before cutoff:\n${partial}\n\n${advice}`,
    };
  }
  return { toolUseId: '', content: `${why} in ${target} with no matches yet. ${advice}`, isError: true };
}

const cancelledResult: ToolResult = { toolUseId: '', content: 'Search cancelled.', isError: true };

/**
 * Pure-JS grep — the FINAL fallback so the grep tool NEVER hard-fails even when
 * BOTH ripgrep (`rg`, normally bundled) and the system `grep` are missing/broken.
 * Slower than rg, but dependency-free (just fs + the bundled `glob` package).
 * Strictly bounded: wall-clock deadline, file cap, and abort-signal aware.
 */
async function jsGrep(
  pattern: string,
  target: string,
  fileGlob: string | undefined,
  ctx: number | undefined,
  maxResults: number,
  context: ToolContext,
): Promise<ToolResult> {
  let re: RegExp;
  try {
    re = new RegExp(pattern);
  } catch {
    // Invalid regex → match as a literal string.
    re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  }
  const cwd = context.cwd;
  const abs = path.isAbsolute(target) ? target : path.join(cwd, target);
  const deadline = Date.now() + JS_GREP_DEADLINE_MS;
  // One controller drives both the glob walk and the scan loop: fires on the
  // turn's abort signal OR the deadline, so jsGrep can never outlive its budget.
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), JS_GREP_DEADLINE_MS);
  const onOuterAbort = () => ac.abort();
  context.abortSignal?.addEventListener('abort', onOuterAbort, { once: true });

  try {
    let files: string[];
    try {
      const st = await stat(abs);
      if (st.isFile()) {
        files = [abs];
      } else {
        files = await globFn(fileGlob ? `**/${fileGlob}` : '**/*', {
          cwd: abs, nodir: true, absolute: true, dot: false,
          ignore: ['**/node_modules/**', '**/.git/**'],
          signal: ac.signal,
        });
      }
    } catch (err) {
      if (ac.signal.aborted) {
        return context.abortSignal?.aborted
          ? cancelledResult
          : { toolUseId: '', content: `Search timed out after ${JS_GREP_DEADLINE_MS / 1000}s walking ${target} (js fallback). Narrow the path or add a glob filter.`, isError: true };
      }
      return { toolUseId: '', content: `Search error: cannot access ${target}`, isError: true };
    }
    const truncatedList = files.length > JS_GREP_MAX_FILES;
    if (truncatedList) files = files.slice(0, JS_GREP_MAX_FILES);
    const out: string[] = [];
    let count = 0;
    let stopped: 'deadline' | 'aborted' | undefined;
    for (const f of files) {
      if (count >= maxResults) break;
      if (context.abortSignal?.aborted) { stopped = 'aborted'; break; }
      if (Date.now() > deadline) { stopped = 'deadline'; break; }
      let text: string;
      try {
        const st = await stat(f);
        if (st.size > 2 * 1024 * 1024) continue; // skip large files
        text = await readFile(f, 'utf-8');
      } catch { continue; }
      if (text.includes('\x00')) continue; // skip binary
      const lines = text.split('\n');
      for (let i = 0; i < lines.length && count < maxResults; i++) {
        if (re.test(lines[i]!)) {
          const rel = path.relative(cwd, f) || f;
          if (ctx) {
            for (let j = Math.max(0, i - ctx); j <= Math.min(lines.length - 1, i + ctx); j++) {
              out.push(`${rel}:${j + 1}:${lines[j]}`);
            }
          } else {
            out.push(`${rel}:${i + 1}:${lines[i]}`);
          }
          count++;
        }
      }
    }
    if (stopped === 'aborted') return cancelledResult;
    const notes: string[] = [];
    if (stopped === 'deadline') notes.push(`stopped at the ${JS_GREP_DEADLINE_MS / 1000}s budget — results are partial; narrow the path or add a glob filter`);
    if (truncatedList) notes.push(`only the first ${JS_GREP_MAX_FILES} files were scanned`);
    const suffix = notes.length ? `\n(note: ${notes.join('; ')})` : '';
    if (!out.length) {
      return stopped || truncatedList
        ? { toolUseId: '', content: `No matches found in the scanned subset.${suffix}`, isError: stopped === 'deadline' }
        : { toolUseId: '', content: 'No matches found.' };
    }
    const capped = formatGrepMatches(out.join('\n'));
    return { toolUseId: '', content: `${capped}${suffix}` };
  } finally {
    clearTimeout(timer);
    context.abortSignal?.removeEventListener('abort', onOuterAbort);
  }
}

/** Fallback to native grep when ripgrep is not installed */
async function grepFallback(
  pattern: string,
  target: string,
  fileGlob: string | undefined,
  ctx: number | undefined,
  maxResults: number,
  context: ToolContext,
): Promise<ToolResult> {
  const args = ['-r', '-n', '--color=never'];
  if (ctx) args.push(`-C${ctx}`);
  if (fileGlob) args.push(`--include=${fileGlob}`);
  args.push('-m', String(maxResults));
  args.push('--', pattern, target);

  try {
    const { stdout } = await execFileAsync('grep', args, {
      cwd: context.cwd,
      timeout: SEARCH_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES,
      signal: context.abortSignal,
    });
    return { toolUseId: '', content: formatGrepMatches(stdout) };
  } catch (err: unknown) {
    switch (classifyExecError(err)) {
      case 'no-match':
        return { toolUseId: '', content: 'No matches found.' };
      case 'aborted':
        return cancelledResult;
      case 'timeout':
        return timeoutResult('timeout', err, target);
      case 'output-overflow':
        return timeoutResult('output-overflow', err, target);
      case 'not-runnable':
        // System grep also missing/broken → pure-JS fallback (so grep NEVER hard-fails).
        return await jsGrep(pattern, target, fileGlob, ctx, maxResults, context);
    }
  }
}

export const grepTool: ToolHandler = {
  name: 'grep',
  description:
    'Search file contents using ripgrep (rg). Supports regex patterns. ' +
    'Returns matching lines with file paths and line numbers.',
  parameters: z.object({
    pattern: z.string().describe('Regex pattern to search for'),
    path: z.string().optional().describe('File or directory to search (default: cwd)'),
    glob: z.string().optional().describe('File glob filter (e.g., "*.ts")'),
    context: z.number().int().min(0).max(10).optional().describe('Lines of context around matches'),
    max_results: z.number().int().min(1).max(500).optional().default(100).describe('Max results'),
  }),
  readOnly: true,
  riskLevel: 'low',
  // Belt-and-braces: even if every internal bound regresses, the agent loop
  // abandons a silent grep after this long instead of wedging the turn.
  silentTimeoutMs: 120_000,

  async execute(params: unknown, context: ToolContext): Promise<ToolResult> {
    const { pattern, path: searchPath, glob: fileGlob, context: ctx, max_results } = this.parameters.parse(params);
    const target = searchPath ?? context.cwd;

    const args = ['--no-heading', '--line-number', '--color=never', `--max-count=${max_results}`];
    if (fileGlob) args.push(`--glob=${fileGlob}`);
    if (ctx) args.push(`-C${ctx}`);
    args.push('--', pattern, target);

    try {
      const { stdout } = await execFileAsync('rg', args, {
        cwd: context.cwd,
        timeout: SEARCH_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES,
        signal: context.abortSignal,
      });
      return { toolUseId: '', content: formatGrepMatches(stdout) };
    } catch (err: unknown) {
      switch (classifyExecError(err)) {
        case 'no-match':
          return { toolUseId: '', content: 'No matches found.' };
        case 'aborted':
          return cancelledResult;
        // A search rg couldn't finish must NOT cascade to slower fallbacks —
        // report it (with any partial results) so the model narrows the search.
        case 'timeout':
          return timeoutResult('timeout', err, target);
        case 'output-overflow':
          return timeoutResult('output-overflow', err, target);
        case 'not-runnable':
          // rg binary missing/broken (ENOENT, exec-format, spawn error) →
          // fall back to system grep, which itself chains to a pure-JS grep.
          return await grepFallback(pattern, target, fileGlob, ctx, max_results, context);
      }
    }
  },
};
