/** Hook event types — modeled after Claude Code + OpenClaw hook systems */
export type HookEvent =
  | 'PreToolUse'        // Before a tool call (exit 2 = block)
  | 'PostToolUse'       // After a tool call completes
  | 'Notification'      // Agent sends a notification
  | 'Stop'              // Agent stops processing
  | 'PreCompact'        // Before context compaction
  | 'PostCompact'       // After context compaction
  | 'SessionStart'      // Agent session starts (gateway boot / resume)
  | 'SessionStop'       // Agent session stops (shutdown)
  | 'MessageReceived'   // Inbound user message (before agent processes)
  | 'MessageSent'       // Agent response complete (after all turns)
  | 'AgentError'        // Agent hit an error (LLM failure, tool error, etc.)
  | 'WebhookReceived';  // External webhook trigger received

/** Single hook definition from config */
export interface HookConfig {
  /** When to run: PreToolUse, PostToolUse, Notification, Stop */
  event: HookEvent;
  /** Optional tool name pattern (glob). If set, only runs for matching tools. */
  matcher?: string;
  /** Shell command to execute */
  command: string;
  /** Timeout in ms (default: 10000) */
  timeout?: number;
}

/** Result from running a hook */
export interface HookResult {
  /** stdout from the hook command */
  stdout: string;
  /** stderr from the hook command */
  stderr: string;
  /** Exit code: 0 = ok, 2 = block (PreToolUse only), other = error */
  exitCode: number;
  /** Whether the hook blocked the tool call (exit code 2) */
  blocked: boolean;
  /** Reason for blocking (from stdout when exit code 2) */
  blockReason?: string;
}

/**
 * Environment variables available to lifecycle hooks.
 *
 * SessionStart / SessionStop hooks receive:
 *   SESSION_ID       — current session ID
 *   MODEL            — active model slug
 *   CWD              — working directory
 *   BACKGROUND_TASKS — JSON array of `{id, type, status, description}` for
 *                      non-terminal background tasks (SCLI-618; SessionStop only)
 *   ACTIVE_CRONS     — JSON array of `{id, name, schedule}` for enabled cron
 *                      jobs (SCLI-618; SessionStop only)
 */
export interface HookEnv {
  SESSION_ID: string;
  MODEL: string;
  CWD: string;
  /** JSON string; empty array when no background tasks are active. */
  BACKGROUND_TASKS?: string;
  /** JSON string; empty array when no cron jobs are scheduled. */
  ACTIVE_CRONS?: string;
}
