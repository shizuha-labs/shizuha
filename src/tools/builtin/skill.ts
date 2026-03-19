/**
 * Skill tool — allows the LLM to invoke registered skills.
 *
 * Skills are markdown-based prompt injections for common tasks
 * (e.g., /commit, /review-pr, /pdf). The LLM calls this tool
 * to load and execute a skill's prompt content.
 */

import { z } from 'zod';
import type { ToolHandler, ToolResult } from '../types.js';
import type { SkillRegistry } from '../../skills/registry.js';

/** Create the skill tool with a reference to the skill registry. */
export function createSkillTool(skillRegistry: SkillRegistry): ToolHandler {
  return {
    name: 'skill',
    description:
      'Invoke a registered skill by name. Skills are specialized prompts for common tasks ' +
      'like creating commits, reviewing PRs, generating documentation, etc. ' +
      'Use the skill catalog in the system prompt to see available skills.',
    parameters: z.object({
      skill: z.string().describe('The skill name to invoke (e.g., "commit", "review-pr")'),
      args: z.string().optional().describe('Optional arguments to pass to the skill'),
    }),
    readOnly: true,
    riskLevel: 'low' as const,

    async execute(params: unknown, context): Promise<ToolResult> {
      const { skill: skillName, args } = params as { skill: string; args?: string };

      const result = skillRegistry.invoke(skillName, args);

      if (!result.success) {
        const available = skillRegistry.listModelInvocable()
          .map((s) => s.name)
          .join(', ');

        return {
          toolUseId: '',
          content: `Skill "${skillName}" not found. Available skills: ${available || 'none'}`,
          isError: true,
        };
      }

      // For inline mode, return the skill prompt as the tool result.
      // The LLM will read this and follow the skill's instructions.
      if (result.mode === 'inline') {
        let response = `# Skill: ${result.skillName}\n\n${result.prompt}`;

        if (result.allowedTools?.length) {
          response += `\n\n**Allowed tools for this skill**: ${result.allowedTools.join(', ')}`;
        }

        return {
          toolUseId: '',
          content: response,
          isError: false,
          metadata: {
            skillName: result.skillName,
            mode: 'inline',
            allowedTools: result.allowedTools,
            model: result.model,
          },
        };
      }

      // For forked mode, we'd spawn a sub-agent — for now, treat as inline
      // since sub-agent spawning requires deeper integration with the agent loop.
      return {
        toolUseId: '',
        content: `# Skill: ${result.skillName} (forked)\n\n${result.prompt}`,
        isError: false,
        metadata: {
          skillName: result.skillName,
          mode: 'forked',
          allowedTools: result.allowedTools,
          model: result.model,
        },
      };
    },
  };
}
