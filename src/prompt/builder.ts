import * as fs from 'node:fs';
import type { ToolDefinition } from '../tools/types.js';
import type { PermissionMode } from '../permissions/types.js';
import { BASE_SYSTEM_PROMPT, ROLE_PROMPTS } from './templates.js';
import { loadMemory } from '../state/memory.js';
import { getGitStatus, getGitBranch, isGitRepo } from '../utils/git.js';

/** Sentinel inserted between static (base prompt, role, custom instructions) and dynamic (git, memory, tools) sections.
 *  Provider plugins can split on this marker to apply different cache scopes. */
export const DYNAMIC_BOUNDARY_MARKER = '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__';

export interface PromptContext {
  cwd: string;
  role?: string;
  customPrompt?: string;
  tools: ToolDefinition[];
  provider?: string;
  /** Current permission mode (plan/supervised/autonomous) */
  mode?: PermissionMode;
  /** Active plan file path (only in plan mode) */
  planFilePath?: string;
  /** MCP server awareness section (added when tool search is enabled) */
  mcpAwareness?: string;
  /** Pre-built skill catalog section (from SkillRegistry.buildCatalog()) */
  skillCatalog?: string;
}

/** Assemble the full system prompt.
 *
 *  Sections 1-3 (base prompt, role, custom instructions) are **static** across sessions.
 *  Sections 4-6 (git context, memory, tools) are **dynamic** per session.
 *  A DYNAMIC_BOUNDARY_MARKER is inserted between them so provider plugins can
 *  apply different cache scopes to static vs dynamic portions. */
export async function buildSystemPrompt(ctx: PromptContext): Promise<string> {
  const staticSections: string[] = [];
  const dynamicSections: string[] = [];

  // ── Static sections (stable across sessions) ──

  // 1. Base prompt
  staticSections.push(BASE_SYSTEM_PROMPT.replace('{cwd}', ctx.cwd));

  // 2. Role-specific prompt
  if (ctx.role && ROLE_PROMPTS[ctx.role]) {
    staticSections.push(ROLE_PROMPTS[ctx.role]!);
  }

  // 3. Custom prompt override
  if (ctx.customPrompt) {
    staticSections.push(`## Custom Instructions\n\n${ctx.customPrompt}`);
  }

  // ── Dynamic sections (change per session/turn) ──

  // 4. Git context
  if (await isGitRepo(ctx.cwd)) {
    const branch = await getGitBranch(ctx.cwd);
    const status = await getGitStatus(ctx.cwd);
    if (branch || status) {
      dynamicSections.push(`## Git Context\nBranch: ${branch}\n${status ? `Status:\n${status}` : ''}`);
    }
  }

  // 5. Memory (CLAUDE.md, .shizuha/memory.md)
  const memory = await loadMemory(ctx.cwd);
  if (memory) {
    dynamicSections.push(`## Project Memory\n\n${memory}`);
  }

  // 6. Tool list
  if (ctx.tools.length > 0) {
    const toolList = ctx.tools.map((t) => `- **${t.name}**: ${t.description}`).join('\n');
    dynamicSections.push(`## Available Tools\n\n${toolList}`);
  }

  // 7. MCP server awareness (when tool search is enabled)
  if (ctx.mcpAwareness) {
    dynamicSections.push(ctx.mcpAwareness);
  }

  // 8. Skill catalog
  if (ctx.skillCatalog) {
    dynamicSections.push(ctx.skillCatalog);
  }

  // 9. Plan mode reminder (dynamic — changes with mode toggle)
  if (ctx.mode === 'plan' && ctx.planFilePath) {
    dynamicSections.push(buildPlanModeReminder(ctx.planFilePath));
  }

  const sep = '\n\n---\n\n';
  if (dynamicSections.length === 0) {
    return staticSections.join(sep);
  }
  return [...staticSections, DYNAMIC_BOUNDARY_MARKER, ...dynamicSections].join(sep);
}

/** Build a plan mode system prompt reminder matching Claude Code's plan mode behavior */
function buildPlanModeReminder(planFilePath: string): string {
  const planExists = fs.existsSync(planFilePath);
  const planFileSection = planExists
    ? `A plan file exists at \`${planFilePath}\`. Read it and make incremental edits.`
    : `No plan file exists yet. Create your plan at \`${planFilePath}\` using the write_file tool.`;

  return `## Plan Mode Active

Plan mode is active. You MUST NOT make any edits except to the plan file below.
Do not run any non-readonly tools, change configs, or make commits.

### Plan File
${planFileSection}
This is the ONLY file you are allowed to edit.

### Workflow
1. **Explore**: Read files, search code (Glob, Grep, Read tools)
2. **Design**: Consider approaches, identify files to modify
3. **Write Plan**: Write your plan to the plan file incrementally
4. **Exit**: Call exit_plan_mode when ready for user approval

End turns with either ask_user (clarifications) or exit_plan_mode (plan approval).
Do NOT ask about plan approval via text — always use exit_plan_mode.`;
}
