import type { AgentConfig } from './types.js';
import type { AgentEvent } from '../events/types.js';
import { runAgent } from './loop.js';
import { logger } from '../utils/logger.js';

export interface SubAgentOptions {
  description: string;
  prompt: string;
  model?: string;
  cwd?: string;
  maxTurns?: number;
}

/**
 * Spawn a sub-agent with isolated context.
 * Runs to completion and returns the final text output.
 */
export async function spawnSubAgent(
  parentConfig: AgentConfig,
  options: SubAgentOptions,
): Promise<string> {
  const subConfig: AgentConfig = {
    model: options.model ?? parentConfig.model,
    cwd: options.cwd ?? parentConfig.cwd,
    maxTurns: options.maxTurns ?? parentConfig.maxTurns ?? 0,
    permissionMode: parentConfig.permissionMode,
    temperature: 0,
    maxOutputTokens: 8192,
  };

  logger.info({ description: options.description }, 'Sub-agent started');

  const events: AgentEvent[] = [];
  let textOutput = '';

  // Inject the prompt as the initial user message by including it in the system prompt
  subConfig.systemPrompt = options.prompt;

  for await (const event of runAgent(subConfig)) {
    events.push(event);
    if (event.type === 'content') {
      textOutput += event.text;
    }
    if (event.type === 'error') {
      logger.error({ error: event.error }, 'Sub-agent error');
    }
  }

  logger.info({ description: options.description, events: events.length }, 'Sub-agent completed');
  return textOutput || '[Sub-agent produced no output]';
}
