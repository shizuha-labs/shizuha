import { spawn } from 'node:child_process';
import { z } from 'zod';
import type { ToolHandler, ToolContext, ToolResult } from '../types.js';

const MAX_OUTPUT = 30000;
const DEFAULT_TIMEOUT_MS = 30000;
const MAX_TIMEOUT_MS = 600000;
const SIGKILL_GRACE_MS = 2000;

function killProcessGroup(proc: ReturnType<typeof spawn>): void {
  const pid = proc.pid;
  if (pid == null) return;
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try { proc.kill('SIGTERM'); } catch { /* ignore */ }
  }
  const timer = setTimeout(() => {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try { proc.kill('SIGKILL'); } catch { /* ignore */ }
    }
  }, SIGKILL_GRACE_MS);
  timer.unref();
  proc.once('exit', () => clearTimeout(timer));
}

export const remoteExecTool: ToolHandler = {
  name: 'remote_exec',
  description:
    'Execute a command on a remote host via SSH. This is a high-risk native SCLI tool; ' +
    'use it only for explicitly requested operations on known hosts. The local SSH client ' +
    'is invoked directly with arguments, not through a local shell. Requires SSH key or agent access.',
  parameters: z.object({
    host: z.string().min(1).describe('SSH target, e.g. user@host or host alias from ssh_config'),
    command: z.string().min(1).describe('Command to execute on the remote host'),
    timeout: z.coerce.number().int().min(1).max(600).optional()
      .describe('Timeout in seconds, 1-600. Default: 30.'),
  }),
  readOnly: false,
  riskLevel: 'high',
  silentTimeoutMs: 30000,

  async execute(params: unknown, context: ToolContext): Promise<ToolResult> {
    const { host, command, timeout } = this.parameters.parse(params);
    const timeoutMs = Math.min((timeout ?? DEFAULT_TIMEOUT_MS / 1000) * 1000, MAX_TIMEOUT_MS);

    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let resolved = false;
      let timedOut = false;
      let aborted = false;

      const safeResolve = (result: ToolResult) => {
        if (!resolved) {
          resolved = true;
          resolve(result);
        }
      };

      const proc = spawn('ssh', [
        '-o', 'StrictHostKeyChecking=no',
        '-o', 'ConnectTimeout=10',
        host,
        command,
      ], {
        cwd: context.cwd,
        detached: true,
        env: { ...process.env, TERM: 'dumb' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const timeoutTimer = setTimeout(() => {
        timedOut = true;
        killProcessGroup(proc);
      }, timeoutMs);
      timeoutTimer.unref();

      const onAbort = () => {
        aborted = true;
        killProcessGroup(proc);
      };
      if (context.abortSignal) {
        if (context.abortSignal.aborted) onAbort();
        else context.abortSignal.addEventListener('abort', onAbort, { once: true });
      }

      const append = (chunk: Buffer, stream: 'stdout' | 'stderr') => {
        if (stream === 'stdout') stdout += chunk.toString();
        else stderr += chunk.toString();
        if ((stdout.length + stderr.length) > MAX_OUTPUT) {
          stdout = stdout.slice(0, MAX_OUTPUT);
          stderr = stderr.slice(0, Math.max(0, MAX_OUTPUT - stdout.length));
          killProcessGroup(proc);
        }
      };

      proc.stdout.on('data', (data: Buffer) => append(data, 'stdout'));
      proc.stderr.on('data', (data: Buffer) => append(data, 'stderr'));

      proc.on('error', (err) => {
        clearTimeout(timeoutTimer);
        if (context.abortSignal) context.abortSignal.removeEventListener('abort', onAbort);
        safeResolve({ toolUseId: '', content: `SSH error: ${err.message}`, isError: true });
      });

      proc.on('close', (code, signal) => {
        clearTimeout(timeoutTimer);
        if (context.abortSignal) context.abortSignal.removeEventListener('abort', onAbort);

        const combined = [stdout.trimEnd(), stderr.trimEnd()].filter(Boolean).join('\n');
        if (aborted) {
          safeResolve({ toolUseId: '', content: `Remote exec aborted.\n${combined}`.trim(), isError: true });
          return;
        }
        if (timedOut) {
          safeResolve({ toolUseId: '', content: `Remote exec timed out after ${timeoutMs}ms.\n${combined}`.trim(), isError: true });
          return;
        }
        if (code !== 0) {
          safeResolve({
            toolUseId: '',
            content: combined || `ssh exited with code ${code}${signal ? ` signal ${signal}` : ''}`,
            isError: true,
          });
          return;
        }
        safeResolve({ toolUseId: '', content: combined || '(empty output)' });
      });
    });
  },
};
