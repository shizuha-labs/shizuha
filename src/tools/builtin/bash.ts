import { z } from 'zod';
import { spawn } from 'node:child_process';
import type { ToolHandler, ToolContext, ToolResult } from '../types.js';
import { buildSandboxedSpawn } from '../../sandbox/index.js';

const MAX_OUTPUT = 30000; // 30K chars max output
const DEFAULT_TIMEOUT = 120000; // 2 minutes default — agent can set longer via timeout param
const SIGKILL_GRACE_MS = 2000; // 2s grace period before SIGKILL escalation

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
    'Use TaskOutput to read the result later. You will be automatically notified when it completes.',
  parameters: z.object({
    command: z.string().describe('The bash command to execute'),
    timeout: z.number().int().min(1000).max(600000).optional().describe('Timeout in milliseconds (default: 120000). Set higher for long test suites.'),
    run_in_background: z.boolean().optional().describe('Set to true to run this command in the background. Returns a task ID immediately. Use TaskOutput to check on output later.'),
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

    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let killed = false;
      let timedOut = false;
      let resolved = false;

      const safeResolve = (result: ToolResult) => {
        if (!resolved) {
          resolved = true;
          resolve(result);
        }
      };

      // Apply OS-level sandbox if configured
      const baseEnv = { ...process.env, TERM: 'dumb' } as Record<string, string>;
      const sandboxOpts = context.sandbox
        ? buildSandboxedSpawn(command, context.cwd, context.sandbox, baseEnv)
        : null;

      // Use SHIZUHA_BASH_PATH if set (e.g. Android where bash isn't on PATH)
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

      // Manual timeout — we handle it ourselves so we can kill the process group.
      // Node's built-in spawn timeout only sends killSignal to the direct child,
      // leaving grandchildren (e.g. python3) orphaned and running forever.
      const timeoutTimer = setTimeout(() => {
        timedOut = true;
        killProcessGroup(proc);
      }, timeoutMs);
      timeoutTimer.unref();

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

        // Detect timeout or signal-based kill
        if (timedOut || (code === null && signal)) {
          timedOut = true;
        }

        let output = '';
        if (stdout) output += stdout;
        if (stderr) output += (output ? '\n' : '') + stderr;
        if (killed && !timedOut) output += '\n[Output truncated]';
        if (timedOut) output += `\n[Command timed out after ${Math.round(timeoutMs / 1000)}s — process group was killed. The command did not finish. You should investigate: re-run with a longer timeout, or run a subset of the work.]`;

        if (output.length > MAX_OUTPUT) {
          const truncatedLines = output.slice(MAX_OUTPUT).split('\n').length;
          output = output.slice(0, MAX_OUTPUT) + `\n\n... [${truncatedLines} lines truncated] ...`;
        }

        safeResolve({
          toolUseId: '',
          content: output || `Command completed with exit code ${code ?? 0}`,
          // isError: true if non-zero exit, timed out, or killed by signal
          isError: timedOut || (code !== null && code !== 0) || (code === null && signal !== null),
        });
      });

      proc.on('error', (err) => {
        clearTimeout(timeoutTimer);
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
  const baseEnv = { ...process.env, TERM: 'dumb' } as Record<string, string>;
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
    content: `Command running in background with task ID: ${task.id}\nYou will be automatically notified when it completes — no need to poll or check.`,
  });
}
