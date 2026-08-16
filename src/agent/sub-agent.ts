import type { AgentConfig } from './types.js';
import type { AgentEvent } from '../events/types.js';
import { runAgent } from './loop.js';
import { logger } from '../utils/logger.js';

export interface SubAgentOptions {
  /** Short task description (shown in logs/UI). */
  description: string;
  /** Detailed prompt for the sub-agent to execute. */
  prompt: string;
  /** Override model (defaults to parent's model). */
  model?: string;
  /** Working directory (defaults to parent's cwd). */
  cwd?: string;
  /** Max turns (defaults to parent's limit, 0 = unlimited). */
  maxTurns?: number;
  /** Abort signal for cancellation. */
  signal?: AbortSignal;
}

export interface SubAgentResult {
  /** Collected text output from the sub-agent. */
  output: string;
  /** Number of turns executed. */
  turns: number;
  /** Total input tokens consumed. */
  inputTokens: number;
  /** Total output tokens generated. */
  outputTokens: number;
  /** Duration in milliseconds. */
  durationMs: number;
  /** Whether the sub-agent encountered an error. */
  hadError: boolean;
}

/**
 * Spawn a sub-agent with isolated context.
 *
 * The sub-agent:
 * - Gets its own conversation context (no shared history with parent)
 * - Uses the same model and provider as the parent (unless overridden)
 * - Has access to all the same tools
 * - Runs autonomously to completion
 * - Returns its text output + metrics
 *
 * This is provider-agnostic — works with any LLM provider (vLLM, Ollama, Anthropic, etc.)
 */
export async function spawnSubAgent(
  parentConfig: AgentConfig,
  options: SubAgentOptions,
): Promise<SubAgentResult> {
  const startTime = Date.now();

  const subConfig: AgentConfig = {
    model: options.model ?? parentConfig.model,
    cwd: options.cwd ?? parentConfig.cwd,
    maxTurns: options.maxTurns ?? 30, // reasonable default for sub-tasks
    permissionMode: 'autonomous', // sub-agents don't ask for permission
    temperature: parentConfig.temperature,  // inherit parent's temperature (set by model profile)
    maxOutputTokens: parentConfig.maxOutputTokens,
    maxContextTokens: parentConfig.maxContextTokens,
    ...(options.signal ? { abortSignal: options.signal } : {}),
    // Sub-agents get the same provider config via model name
    // (the registry resolves model → provider automatically)
  };

  logger.info(
    { description: options.description, model: subConfig.model },
    'Sub-agent spawning',
  );

  let textOutput = '';
  let turns = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let hadError = false;

  try {
    for await (const event of runAgent(subConfig, options.prompt)) {
      if (options.signal?.aborted) {
        logger.info({ description: options.description }, 'Sub-agent aborted');
        break;
      }

      switch (event.type) {
        case 'content':
          textOutput += event.text;
          break;
        case 'turn_complete':
          turns++;
          totalInputTokens += event.inputTokens ?? 0;
          totalOutputTokens += event.outputTokens ?? 0;
          break;
        case 'error':
          hadError = true;
          logger.error(
            { error: event.error, description: options.description },
            'Sub-agent error',
          );
          break;
      }
    }
  } catch (err) {
    hadError = true;
    logger.error({ err, description: options.description }, 'Sub-agent crashed');
    textOutput += `\n[Sub-agent error: ${(err as Error).message}]`;
  }

  const durationMs = Date.now() - startTime;

  logger.info(
    {
      description: options.description,
      turns,
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      durationMs,
      hadError,
    },
    'Sub-agent completed',
  );

  return {
    output: textOutput || '[Sub-agent produced no output]',
    turns,
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    durationMs,
    hadError,
  };
}
