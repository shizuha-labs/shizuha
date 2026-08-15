import { execSync } from 'node:child_process';
import type { HookConfig, HookEvent, HookResult } from './types.js';
import { logger } from '../utils/logger.js';

/**
 * HookEngine — executes lifecycle hooks (shell commands) at defined points.
 *
 * Environment variables passed to hooks:
 *   TOOL_NAME    — tool being called (PreToolUse/PostToolUse)
 *   TOOL_INPUT   — JSON-serialized tool input
 *   TOOL_RESULT  — tool output (PostToolUse only)
 *   TOOL_ERROR   — "true" if tool errored (PostToolUse only)
 *   SESSION_ID   — current session ID
 *   CWD          — working directory
 *
 * Exit codes:
 *   0 — hook passed (continue)
 *   2 — block tool execution (PreToolUse only)
 *   other — hook error (logged, does not block)
 */
export class HookEngine {
  private hooks: HookConfig[];

  constructor(hooks: HookConfig[] = []) {
    this.hooks = hooks;
  }

  /** Run all hooks matching the given event and optional tool name */
  async runHooks(
    event: HookEvent,
    env: Record<string, string>,
    toolName?: string,
  ): Promise<HookResult[]> {
    const matching = this.hooks.filter((h) => {
      if (h.event !== event) return false;
      if (h.matcher && toolName) {
        return matchGlob(h.matcher, toolName);
      }
      return true;
    });

    const results: HookResult[] = [];
    for (const hook of matching) {
      const result = this.executeHook(hook, env);
      results.push(result);
      // If PreToolUse hook blocks, stop running further hooks
      if (event === 'PreToolUse' && result.blocked) break;
    }
    return results;
  }

  private executeHook(hook: HookConfig, env: Record<string, string>): HookResult {
    const timeout = hook.timeout ?? 10000;
    try {
      const stdout = execSync(hook.command, {
        timeout,
        encoding: 'utf-8',
        env: { ...process.env, ...env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return { stdout: stdout.trim(), stderr: '', exitCode: 0, blocked: false };
    } catch (err) {
      const execErr = err as { status?: number; stdout?: string; stderr?: string; message?: string };
      const exitCode = execErr.status ?? 1;
      const stdout = (execErr.stdout ?? '').trim();
      const stderr = (execErr.stderr ?? '').trim();

      if (exitCode === 2) {
        // PreToolUse block signal
        logger.info({ command: hook.command, reason: stdout }, 'Hook blocked tool execution');
        return {
          stdout,
          stderr,
          exitCode: 2,
          blocked: true,
          blockReason: stdout || 'Blocked by hook',
        };
      }

      logger.warn({ command: hook.command, exitCode, stderr }, 'Hook exited with error');
      return { stdout, stderr, exitCode, blocked: false };
    }
  }

  /** Check if any hooks are registered for a given event */
  hasHooks(event: HookEvent): boolean {
    return this.hooks.some((h) => h.event === event);
  }
}

/** Simple glob matching: supports * and prefix matching */
function matchGlob(pattern: string, value: string): boolean {
  if (pattern === '*') return true;
  if (pattern === value) return true;
  if (pattern.endsWith('*') && value.startsWith(pattern.slice(0, -1))) return true;
  // mcp__ prefix matching
  if (pattern.startsWith('mcp__') && value.startsWith(pattern)) return true;
  return false;
}
