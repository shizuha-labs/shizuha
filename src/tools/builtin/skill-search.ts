/**
 * Skill search tools — search_skills and use_skill.
 *
 * Wraps the SkillSearchEngine from cron-mcp for use as built-in tools
 * in the Shizuha runtime (bare_metal + container agents).
 */

import { z } from 'zod';
import type { ToolHandler, ToolContext, ToolResult } from '../types.js';
import { SkillSearchEngine } from '../../cron-mcp/skill-search.js';

/** Shared engine instance — set by AgentProcess during init */
let sharedEngine: SkillSearchEngine | null = null;

/** Called by AgentProcess to inject the skill search engine */
export function setSkillSearchEngine(engine: SkillSearchEngine): void {
  sharedEngine = engine;
}

export const searchSkillsTool: ToolHandler = {
  name: 'search_skills',
  description:
    'Search for skills (knowledge/recipes) by keyword or topic. ' +
    'Skills teach you how to use specific tools, APIs, or workflows.\n' +
    'Use this BEFORE attempting unfamiliar tasks — a skill may already exist.\n\n' +
    'Examples:\n' +
    '  search_skills(query="smart home lights")\n' +
    '  search_skills(query="project management kanban")\n' +
    '  search_skills(query="note taking macos")',
  parameters: z.object({
    query: z.string().describe('Search query — keywords, topics, or tool names'),
    max_results: z.number().optional().default(5).describe('Max results (default: 5)'),
  }),
  readOnly: true,
  riskLevel: 'low' as const,

  async execute(params: unknown, _context: ToolContext): Promise<ToolResult> {
    if (!sharedEngine) {
      return { toolUseId: '', content: 'Skill search not initialized', isError: true };
    }
    const { query, max_results } = (this as any).parameters.parse(params);
    const results = sharedEngine.search(query, max_results);

    if (results.length === 0) {
      return { toolUseId: '', content: `No skills found for "${query}".` };
    }

    const formatted = results.map((r, i) =>
      `${i + 1}. **${r.name}** (score: ${r.score})\n   ${r.description}\n   Tags: ${r.tags.join(', ')}`
    ).join('\n\n');

    return { toolUseId: '', content: formatted };
  },
};

export const useSkillTool: ToolHandler = {
  name: 'use_skill',
  description:
    'Load a skill by name to get detailed instructions. ' +
    'Use after search_skills finds a relevant skill.',
  parameters: z.object({
    name: z.string().describe('Skill name (from search_skills results)'),
  }),
  readOnly: true,
  riskLevel: 'low' as const,

  async execute(params: unknown, _context: ToolContext): Promise<ToolResult> {
    if (!sharedEngine) {
      return { toolUseId: '', content: 'Skill search not initialized', isError: true };
    }
    const { name } = (this as any).parameters.parse(params);
    const content = sharedEngine.getSkillContent(name);

    if (!content) {
      return {
        toolUseId: '',
        content: `Skill "${name}" not found. Use search_skills to find available skills.`,
        isError: true,
      };
    }

    return { toolUseId: '', content };
  },
};
