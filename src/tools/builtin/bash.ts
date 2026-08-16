import { z } from 'zod';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ToolHandler, ToolContext, ToolResult } from '../types.js';
import { buildSandboxedSpawn } from '../../sandbox/index.js';

const MAX_OUTPUT = 30000; // 30K chars max output

// Persistent working directory per session — makes `cd` behave like a real
// terminal across separate bash tool calls (Claude Code / Codex keep a live
// shell; we emulate the cwd part). Without this, `cd foo` in one call is lost
// before the next call, so the model runs commands in the wrong directory and
// repeats the same failure (e.g. `docker compose up` from the repo root).
//
// Backed by an on-disk file per session so it ALSO survives a process restart /
// session resume (the live TUI hit exactly this: a resumed session kept running
// `docker compose up` from the repo root because the in-memory cwd was gone).
const sessionCwd = new Map<string, string>();
const CWD_DIR = path.join(os.homedir(), '.config', 'shizuha', 'bash-cwd');

function cwdFileFor(sessionId: string): string {
  // Sanitize the session id into a safe filename.
  return path.join(CWD_DIR, sessionId.replace(/[^A-Za-z0-9_-]/g, '_'));
}
function getPersistedCwd(sessionId: string | undefined): string | undefined {
  if (!sessionId) return undefined;
  const mem = sessionCwd.get(sessionId);
  if (mem) return mem;
  try {
    const v = fs.readFileSync(cwdFileFor(sessionId), 'utf8').trim();
    if (v) { sessionCwd.set(sessionId, v); return v; }
  } catch { /* none persisted */ }
  return undefined;
}
function setPersistedCwd(sessionId: string | undefined, cwd: string | null): void {
  if (!sessionId) return;
  if (cwd) {
    sessionCwd.set(sessionId, cwd);
    try { fs.mkdirSync(CWD_DIR, { recursive: true }); fs.writeFileSync(cwdFileFor(sessionId), cwd); } catch { /* best effort */ }
  } else {
    sessionCwd.delete(sessionId);
    try { fs.unlinkSync(cwdFileFor(sessionId)); } catch { /* ignore */ }
  }
}
const DEFAULT_TIMEOUT = 120000; // 2 minutes default — agent can set longer via timeout param
const SIGKILL_GRACE_MS = 2000; // 2s grace period before SIGKILL escalation

// Provider credentials authenticate the SCLI process itself. They are not tool
// credentials and must never leak into agent-authored shell programs. A Nova QA
// turn inherited these aliases, generated ad-hoc Node TTFT probes, and sent
// disposable no-session requests directly to Cortex; one such request displaced
// Nova's real 188K-token warm home. Interactive human SCLI sessions keep their
// normal shell environment. Fleet agents obtain explicit task credentials via
// the credential broker instead of borrowing their model-runtime secret.
const AGENT_RUNTIME_ONLY_ENV = [
  'CORTEX_API_KEY',
  'CORTEX_API_KEY_SHARED_FALLBACK',
  'CORTEX_OAUTH_TOKEN',
  'OPENAI_API_KEY',
  'VLLM_API_KEY',
] as const;

function isFleetAgentRuntime(env: NodeJS.ProcessEnv): boolean {
  return Boolean(
    env['AGENT_ID']?.trim()
    || env['AGENT_USERNAME']?.trim()
    || env['SHIZUHA_AGENT_ID']?.trim()
    || env['SHIZUHA_AGENT_USERNAME']?.trim()
    || env['SHIZUHA_K8S_PRIMARY_MODEL']?.trim(),
  );
}

export function bashChildEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const childEnv = Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => (
      typeof entry[1] === 'string'
    )),
  );
  if (isFleetAgentRuntime(env)) {
    for (const name of AGENT_RUNTIME_ONLY_ENV) delete childEnv[name];
  }
  childEnv['TERM'] = 'dumb';
  return childEnv;
}

/**
 * Kill the entire process group, then escalate to SIGKILL if needed.
 * - Spawned with detached:true so the child is a process group leader.
 * - process.kill(-pid) sends the signal to every process in the group,
 *   preventing orphaned grandchildren (e.g. python3 spawned by bash).
 * - Mirrors Codex (process group kill) + Claude Code (SIGTERM→SIGKILL).
 */
function killProcessGroup(proc: ReturnType<typeof spawn>): void {
  const pid = proc.pid;
  if (pid == null) return;

  // SIGTERM the entire process group
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    // Process group may already be gone
    try { proc.kill('SIGTERM'); } catch { /* ignore */ }
  }

  // Escalate to SIGKILL after grace period if still alive
  const escalationTimer = setTimeout(() => {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try { proc.kill('SIGKILL'); } catch { /* ignore */ }
    }
  }, SIGKILL_GRACE_MS);
  escalationTimer.unref(); // Don't keep the event loop alive for this

  // If process exits before the grace period, cancel the SIGKILL
  proc.once('exit', () => clearTimeout(escalationTimer));
}

export const bashTool: ToolHandler = {
  name: 'bash',
  description:
    'Execute a bash command. The command runs in a subprocess with the agent\'s working directory. ' +
    'Output is captured and returned (stdout + stderr). Default timeout is 2 minutes (120000ms). ' +
    'For long-running commands like full test suites, set a higher timeout (up to 10 minutes / 600000ms). ' +
    'For quick checks and targeted tests, use the default or lower. ' +
    'Set run_in_background=true to run the command asynchronously — returns a task ID immediately. ' +
    'When the result is required, call TaskOutput with block=true and a timeout up to 600000ms.',
  parameters: z.object({
    command: z.string().describe('The bash command to execute'),
    timeout: z.coerce.number().int().min(1000).max(600000).optional().describe('Timeout in milliseconds (default: 120000). Set higher for long test suites.'),
    run_in_background: z.union([z.boolean(), z.string().transform(s => s === 'true')]).optional().describe('Set to true to run this command in the background. Returns a task ID immediately. Use TaskOutput to check on output later.'),
  }),
  readOnly: false,
  riskLevel: 'high',

  async execute(params: unknown, context: ToolContext): Promise<ToolResult> {
    const { command, timeout, run_in_background } = this.parameters.parse(params);
    const timeoutMs = timeout ?? DEFAULT_TIMEOUT;

    // Background execution — fire and forget
    if (run_in_background && context.taskRegistry) {
      return launchBackgroundBash(command, timeoutMs, context);
    }

    // Resolve the persistent cwd for this session (falls back to the agent cwd).
    // If a previously cd'd directory no longer exists, drop it and reset.
    const sid = context.sessionId;
    let effectiveCwd = getPersistedCwd(sid) || context.cwd;
    if (effectiveCwd !== context.cwd && !fs.existsSync(effectiveCwd)) {
      effectiveCwd = context.cwd;
      setPersistedCwd(sid, null);
    }
    // Only the non-sandboxed path persists cwd (sandbox restricts writes).
    const captureCwd = !context.sandbox;
    const cwdFile = captureCwd ? path.join(os.tmpdir(), `shizuha-cwd-${randomUUID()}`) : null;
    // Wrap so the post-command $PWD is written to a temp FILE (never stdout, so
    // command output is untouched) while preserving the command's exit code.
    const runCommand = cwdFile
      ? `${command}\n__shizuha_rc=$?\nprintf '%s' "$PWD" > ${JSON.stringify(cwdFile)} 2>/dev/null\nexit $__shizuha_rc`
      : command;

    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let killed = false;
      let timedOut = false;
      let aborted = false;
      let resolved = false;
      let finalCwd = effectiveCwd; // updated from the wrapper-captured PWD
      const persistCwd = () => {
        if (!cwdFile || !sid) return;
        try {
          const nc = fs.readFileSync(cwdFile, 'utf8').trim();
          if (nc) {
            finalCwd = nc;
            setPersistedCwd(sid, nc === context.cwd ? null : nc);
          }
        } catch { /* command exited before wrapper ran (e.g. explicit exit/kill) */ }
        try { fs.unlinkSync(cwdFile); } catch { /* ignore */ }
      };

      const safeResolve = (result: ToolResult) => {
        if (!resolved) {
          resolved = true;
          resolve(result);
        }
      };

      // Apply OS-level sandbox if configured
      const baseEnv = bashChildEnvironment();
      const sandboxOpts = context.sandbox
        ? buildSandboxedSpawn(command, effectiveCwd, context.sandbox, baseEnv)
        : null;

      // Use SHIZUHA_BASH_PATH if set (e.g. Android where bash isn't on PATH)
      const bashBin = process.env.SHIZUHA_BASH_PATH || 'bash';

      const proc = sandboxOpts
        ? spawn(sandboxOpts.command, sandboxOpts.args, {
            cwd: effectiveCwd,
            detached: true,
            env: sandboxOpts.env,
            stdio: ['ignore', 'pipe', 'pipe'],
          })
        : spawn(bashBin, ['-c', runCommand], {
            cwd: effectiveCwd,
            detached: true,
            env: baseEnv,
            stdio: ['ignore', 'pipe', 'pipe'],
          });

      // Manual timeout — we handle it ourselves so we can kill the process group.
      // Node's built-in spawn timeout only sends killSignal to the direct child,
      // leaving grandchildren (e.g. python3) orphaned and running forever.
      const timeoutTimer = setTimeout(() => {
        timedOut = true;
        killProcessGroup(proc);
      }, timeoutMs);
      timeoutTimer.unref();

      // SCLI-39: honor the turn's abort signal. When the user queues a message
      // mid-turn (soft abort), the in-flight bash must be killed — otherwise the
      // turn wedges awaiting a command that never returns and the TUI's running-
      // tool timer ticks unbounded (operator saw `bash (556m)`). Kill the whole
      // process group (SIGTERM→SIGKILL, same as timeout) so grandchildren die too.
      const abortSignal = context.abortSignal;
      const onAbort = () => {
        aborted = true;
        killProcessGroup(proc);
      };
      if (abortSignal) {
        if (abortSignal.aborted) {
          onAbort();
        } else {
          abortSignal.addEventListener('abort', onAbort, { once: true });
        }
      }

      // Throttle progress callbacks to avoid overwhelming the TUI
      let lastProgressTime = 0;
      const PROGRESS_INTERVAL_MS = 500;

      proc.stdout.on('data', (data: Buffer) => {
        stdout += data.toString();
        if (stdout.length > MAX_OUTPUT) {
          killProcessGroup(proc);
          killed = true;
        }
        // Stream incremental output for long-running commands
        if (context.onProgress) {
          const now = Date.now();
          if (now - lastProgressTime >= PROGRESS_INTERVAL_MS) {
            lastProgressTime = now;
            const lines = stdout.split('\n');
            const tail = lines.slice(-5).join('\n');
            context.onProgress(tail);
          }
        }
      });

      proc.stderr.on('data', (data: Buffer) => {
        stderr += data.toString();
        if (stderr.length > MAX_OUTPUT) {
          killProcessGroup(proc);
          killed = true;
        }
      });

      proc.on('close', (code, signal) => {
        clearTimeout(timeoutTimer);
        if (abortSignal) abortSignal.removeEventListener('abort', onAbort);
        persistCwd(); // carry any `cd` into subsequent calls

        // Detect timeout or signal-based kill. An abort kills via signal too, so
        // check `aborted` first to report it distinctly (not as a timeout).
        if (!aborted && (timedOut || (code === null && signal))) {
          timedOut = true;
        }

        let output = '';
        if (stdout) output += stdout;
        if (stderr) output += (output ? '\n' : '') + stderr;
        if (killed && !timedOut && !aborted) output += '\n[Output truncated]';
        if (aborted) output += '\n[Command aborted — a new message was queued mid-turn; the process group was killed.]';
        if (timedOut) output += `\n[Command timed out after ${Math.round(timeoutMs / 1000)}s — process group was killed. The command did not finish. You should investigate: re-run with a longer timeout, or run a subset of the work.]`;

        if (output.length > MAX_OUTPUT) {
          const truncatedLines = output.slice(MAX_OUTPUT).split('\n').length;
          output = output.slice(0, MAX_OUTPUT) + `\n\n... [${truncatedLines} lines truncated] ...`;
        }

        // Always append exit code so the model knows success/failure unambiguously
        const exitCode = code ?? (signal ? 128 : 0);
        if (output && exitCode !== 0) {
          output += `\n\nExit code: ${exitCode}`;
        }

        const isError = timedOut || exitCode !== 0;
        // Ensure there is always a body (so the exit code survives even for a
        // no-output failure) BEFORE appending the cwd annotation.
        let body = output || `Command completed with exit code ${exitCode}`;
        // Surface the actual working directory when a command FAILS or runs
        // outside the agent's base dir. This is ground truth the model can't
        // argue with — it stops the "I already cd'd" delusion that made it run
        // `docker compose up` from the wrong directory over and over.
        if (isError || finalCwd !== context.cwd) {
          body += `\n[cwd: ${finalCwd}]`;
        }

        safeResolve({ toolUseId: '', content: body, isError });
      });

      proc.on('error', (err) => {
        clearTimeout(timeoutTimer);
        try { if (cwdFile) fs.unlinkSync(cwdFile); } catch { /* ignore */ }
        safeResolve({
          toolUseId: '',
          content: `Command failed: ${err.message}`,
          isError: true,
        });
      });
    });
  },
};

/**
 * Launch a bash command as a background task.
 * Returns immediately with a task ID — the command runs asynchronously.
 */
function launchBackgroundBash(command: string, timeoutMs: number, context: ToolContext): Promise<ToolResult> {
  const registry = context.taskRegistry!;
  const desc = command.length > 80 ? command.slice(0, 77) + '...' : command;
  const task = registry.create('bash', desc);

  // Apply OS-level sandbox if configured
  const baseEnv = bashChildEnvironment();
  const sandboxOpts = context.sandbox
    ? buildSandboxedSpawn(command, context.cwd, context.sandbox, baseEnv)
    : null;

  const bashBin = process.env.SHIZUHA_BASH_PATH || 'bash';

  const proc = sandboxOpts
    ? spawn(sandboxOpts.command, sandboxOpts.args, {
        cwd: context.cwd,
        detached: true,
        env: sandboxOpts.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    : spawn(bashBin, ['-c', command], {
        cwd: context.cwd,
        detached: true,
        env: baseEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

  task.pid = proc.pid;

  // Wire abort signal → process kill
  task.abort.signal.addEventListener('abort', () => {
    killProcessGroup(proc);
  }, { once: true });

  // Timeout
  const timeoutTimer = setTimeout(() => {
    killProcessGroup(proc);
    registry.appendOutput(task.id, `\n[Command timed out after ${Math.round(timeoutMs / 1000)}s]`);
    registry.fail(task.id, `Timed out after ${Math.round(timeoutMs / 1000)}s`);
  }, timeoutMs);
  timeoutTimer.unref();

  proc.stdout.on('data', (data: Buffer) => {
    registry.appendOutput(task.id, data.toString());
  });
  proc.stderr.on('data', (data: Buffer) => {
    registry.appendOutput(task.id, data.toString());
  });

  proc.on('close', (code, signal) => {
    clearTimeout(timeoutTimer);
    const t = registry.get(task.id);
    if (t && t.status === 'running') {
      if (code !== null && code !== 0) {
        registry.fail(task.id, `Exited with code ${code}`);
      } else if (code === null && signal) {
        registry.fail(task.id, `Killed by signal ${signal}`);
      } else {
        registry.complete(task.id, code ?? 0);
      }
    }
  });

  proc.on('error', (err) => {
    clearTimeout(timeoutTimer);
    registry.fail(task.id, err.message);
  });

  // Unref so the process doesn't block Node exit
  proc.unref();

  return Promise.resolve({
    toolUseId: '',
    content: `Command running in background with task ID: ${task.id}\nWhen this result is required, call TaskOutput with {"task_id":"${task.id}","block":true,"timeout":${timeoutMs}}.`,
  });
}
