import * as fs from 'node:fs';
import type { ToolDefinition } from '../tools/types.js';
import type { PermissionMode } from '../permissions/types.js';
import { BASE_SYSTEM_PROMPT, LEAN_SYSTEM_PROMPT, TALK_MINIMAL_SYSTEM_PROMPT, AGENT_POLICY, ROLE_PROMPTS } from './templates.js';
import { normalizeRole } from '../platform/mcp-access-matrix.js';
import { isLeanConversationalEnv, talkPromptMode } from '../platform/lean-conversational.js';
import { loadMemory } from '../state/memory.js';
import { getGitStatus, getGitBranch, isGitRepo } from '../utils/git.js';
import { logger } from '../utils/logger.js';

/** EVOL-15: fast token estimate (~4 chars/token). Deliberately NOT the real
 *  tokenizer — this runs every turn on the full composed context, and an exact
 *  count there would add per-turn latency (and superlinear cost on large
 *  inputs). chars/4 is plenty precise for a warn threshold that exists to catch
 *  bloat regressions, not to do exact accounting. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function truncatePromptSection(content: string, maxChars: number | undefined, label: string): string {
  if (!maxChars || content.length <= maxChars) return content;
  return content.slice(0, maxChars).trimEnd()
    + `\n\n[${label} truncated to ${maxChars} chars. Read the source file explicitly if more detail is needed.]`;
}

function prepareProjectMemoryForPrompt(content: string, maxChars: number | undefined, label: string): string {
  let prepared = content;
  if (maxChars) {
    const catalogMarkers = [
      '\n**Skill catalog',
      '\n## Available Skills',
      '\n## Available MCP Servers',
      '\n---\n\n## Available MCP Servers',
    ];
    const cutAt = catalogMarkers
      .map((marker) => prepared.indexOf(marker))
      .filter((idx) => idx >= 0)
      .sort((a, b) => a - b)[0];
    if (cutAt !== undefined) {
      prepared = prepared.slice(0, cutAt).trimEnd()
        + `\n\n[${label} catalog/tool listings omitted. Read the source file explicitly if more detail is needed.]`;
    }
  }
  return truncatePromptSection(prepared, maxChars, label);
}

/** Sentinel inserted between static (base prompt, role, custom instructions) and dynamic (git, memory, tools) sections.
 *  Provider plugins can split on this marker to apply different cache scopes. */
export const DYNAMIC_BOUNDARY_MARKER = '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__';

export interface PromptContext {
  cwd: string;
  role?: string;
  customPrompt?: string;
  tools: ToolDefinition[];
  provider?: string;
  /** Model name — used to look up model profile for prompt adaptation. */
  model?: string;
  /** Resolved context window from the active provider/backend, if known.
   *  This is authoritative for self-hosted models where Cortex/vLLM can change
   *  max_model_len without changing the model's native profile. */
  contextWindow?: number;
  /** Current permission mode (plan/supervised/autonomous) */
  mode?: PermissionMode;
  /** Active plan file path (only in plan mode) */
  planFilePath?: string;
  /** MCP server awareness section (added when tool search is enabled) */
  mcpAwareness?: string;
  /** MCP schemas are deferred behind ToolSearch. Keep discovered MCP tools out
   *  of the textual tool list so the system prompt remains byte-stable while
   *  hosted-provider compatibility schemas evolve in the API tools array. */
  deferredMcpTools?: boolean;
  /** Pre-built skill catalog section (from SkillRegistry.buildCatalog()) */
  skillCatalog?: string;
}

/** EVOL-15: context-budget telemetry. The composed per-turn system context
 *  (system prompt + tool schemas) is measured in TOKENS and compared to a
 *  fraction of the model's window — warn at 20%, fail at 25% (doctrine ccdd36e0).
 *  Fail-mode is ARMED LATER (warn-only in v1): measurement before enforcement,
 *  since every seat today carries ~40-50K of MCP schemas and arming fail before
 *  SCLI-44 lands the allow-lists would block the fleet. Per-model thresholds
 *  resolve from the active provider/backend window when available, then model
 *  nativeContextWindow as fallback, so redeploying Cortex/vLLM at a different
 *  max_model_len does not require editing static model profiles. */
export interface ContextBudgetReport {
  model: string;
  displayName: string;
  systemPromptTokens: number;
  toolSchemaTokens: number;
  /** sub-component of the system prompt — informational breakdown only */
  skillCatalogTokens: number;
  /** systemPrompt + toolSchemas — the composed per-turn overhead */
  totalTokens: number;
  contextWindow: number;
  warnTokens: number;
  failTokens: number;
  overWarn: boolean;
  /** computed but NOT enforced in v1 (fail-mode armed later) */
  overFail: boolean;
  at: string;
}

const CONTEXT_BUDGET_WARN_FRACTION = 0.20;
const CONTEXT_BUDGET_FAIL_FRACTION = 0.25;
/** Flip true post-SCLI-44 to ARM fail-mode (trim/refuse). Warn-only until then. */
const CONTEXT_BUDGET_FAIL_ARMED = false;

let lastContextBudget: ContextBudgetReport | null = null;
/** EVOL-15: the most recent context-budget measurement, for the /health exporter. */
export function getLastContextBudget(): ContextBudgetReport | null {
  return lastContextBudget;
}

async function recordContextBudget(ctx: PromptContext, systemPrompt: string): Promise<void> {
  try {
    const { getModelProfile } = await import('../provider/model-profile.js');
    const profile = getModelProfile(ctx.model ?? '');
    const systemPromptTokens = estimateTokens(systemPrompt);
    const toolSchemaTokens = ctx.tools?.length ? estimateTokens(JSON.stringify(ctx.tools)) : 0;
    const skillCatalogTokens = ctx.skillCatalog ? estimateTokens(ctx.skillCatalog) : 0;
    const totalTokens = systemPromptTokens + toolSchemaTokens;
    const contextWindow = ctx.contextWindow || profile.nativeContextWindow || 0;
    const warnTokens = Math.round(contextWindow * CONTEXT_BUDGET_WARN_FRACTION);
    const failTokens = Math.round(contextWindow * CONTEXT_BUDGET_FAIL_FRACTION);
    const overWarn = warnTokens > 0 && totalTokens > warnTokens;
    const overFail = failTokens > 0 && totalTokens > failTokens;
    lastContextBudget = {
      model: ctx.model ?? 'unknown', displayName: profile.displayName,
      systemPromptTokens, toolSchemaTokens, skillCatalogTokens, totalTokens,
      contextWindow, warnTokens, failTokens, overWarn, overFail,
      at: new Date().toISOString(),
    };
    if (overWarn) {
      logger.warn(
        { ...lastContextBudget, fraction: contextWindow ? +(totalTokens / contextWindow).toFixed(3) : null,
          failArmed: CONTEXT_BUDGET_FAIL_ARMED },
        `EVOL-15 context budget: ${totalTokens} tok composed system context > 20% warn (${warnTokens}) ` +
        `for ${profile.displayName} [window ${contextWindow}] — systemPrompt=${systemPromptTokens} ` +
        `tools=${toolSchemaTokens} skills=${skillCatalogTokens}` +
        (overFail ? ` — OVER 25% fail (${failTokens}); fail-mode armed-later, warn-only in v1` : ''),
      );
    }
    // When CONTEXT_BUDGET_FAIL_ARMED flips true (post-SCLI-44), overFail would
    // trigger deferred-tool trimming / refusal here. Warn-only in v1.
    void CONTEXT_BUDGET_FAIL_ARMED;
  } catch (err) {
    // Telemetry must NEVER break prompt building.
    logger.debug({ err: String(err) }, 'EVOL-15 context-budget telemetry skipped');
  }
}

/** Assemble the full system prompt + record EVOL-15 context-budget telemetry. */
export async function buildSystemPrompt(ctx: PromptContext): Promise<string> {
  const systemPrompt = await composeSystemPrompt(ctx);
  await recordContextBudget(ctx, systemPrompt);
  return systemPrompt;
}

/** Assemble the full system prompt.
 *
 *  Sections 1-3 (base prompt, role, custom instructions) are **static** across sessions.
 *  Sections 4-6 (git context, memory, tools) are **dynamic** per session.
 *  A DYNAMIC_BOUNDARY_MARKER is inserted between them so provider plugins can
 *  apply different cache scopes to static vs dynamic portions. */
async function composeSystemPrompt(ctx: PromptContext): Promise<string> {
  // ── Model-specific prompt adaptation ──
  // Models trained for agentic coding (e.g., Qwen3-Coder-Next) prefer minimal/no system prompts.
  // Their tool-calling behavior was baked in during RL training — heavy prompts interfere.
  let includeToolListInPrompt = true;
  let maxProjectMemoryChars: number | undefined;
  let useLeanBasePrompt = false;
  if (ctx.model) {
    const { getModelProfile } = await import('../provider/model-profile.js');
    const profile = getModelProfile(ctx.model);
    includeToolListInPrompt = profile.includeToolListInPrompt;
    maxProjectMemoryChars = profile.maxProjectMemoryChars;
    useLeanBasePrompt = Boolean(profile.useLeanBasePrompt);

    // noSystemPrompt = send absolutely nothing
    if (profile.noSystemPrompt) {
      return '';
    }

    const talkMode = talkPromptMode();
    if (talkMode !== 'full') {
      const parts: string[] = [];
      if (talkMode === 'minimal') parts.push(TALK_MINIMAL_SYSTEM_PROMPT.trimEnd());
      if (ctx.customPrompt) parts.push(ctx.customPrompt.trim());
      return parts.filter(Boolean).join('\n\n');
    }

    // Model-specific system prompt from file (e.g., qwen-code's prompt for Qwen3-Coder)
    if (profile.systemPromptFile && !profile.useFullSystemPrompt) {
      try {
        const fs = await import('node:fs');
        const path = await import('node:path');
        // Resolve the bundle's real filesystem location — fs.realpathSync handles
        // Docker volume mounts where import.meta.url points to a symlink.
        const bundlePath = fs.realpathSync(new URL(import.meta.url).pathname);
        const bundleDir = path.dirname(bundlePath);
        const candidates = [
          // From bundle: dist/shizuha.js → ../src/prompt/ (standard project layout)
          path.join(bundleDir, '..', 'src', 'prompt', profile.systemPromptFile),
          // Alongside the bundle (if files are copied to dist/)
          path.join(bundleDir, profile.systemPromptFile),
          // From cwd (dev mode — process.cwd() is the project root)
          path.join(process.cwd(), 'src', 'prompt', profile.systemPromptFile),
          path.join(process.cwd(), profile.systemPromptFile),
        ];
        for (const p of candidates) {
          if (fs.existsSync(p)) {
            return fs.readFileSync(p, 'utf-8');
          }
        }
        logger.warn({ file: profile.systemPromptFile, candidates }, 'Model system prompt file not found at any candidate path');
      } catch {
        // Fall through to minimal prompt if file not found
      }
    }

    // useFullSystemPrompt=false = minimal prompt only
    if (!profile.useFullSystemPrompt) {
      const sections: string[] = [];
      if (profile.minimalSystemPrompt) sections.push(profile.minimalSystemPrompt);
      sections.push(`Working directory: ${ctx.cwd}`);
      const memory = await loadMemory(ctx.cwd);
      if (memory) {
        sections.push(`## Project Context\n\n${prepareProjectMemoryForPrompt(memory, maxProjectMemoryChars, 'Project context')}`);
      }
      if (ctx.customPrompt) sections.push(ctx.customPrompt);
      return sections.join('\n\n');
    }
  }

  const staticSections: string[] = [];
  const dynamicSections: string[] = [];

  // ── Static sections (stable across sessions) ──

  // 1. Base prompt — kept byte-identical across agents (operator 2026-07-15):
  // per-agent values like cwd must NOT be woven into the head, or the prefix
  // diverges at the first section and nothing after it is cross-agent cacheable.
  staticSections.push(useLeanBasePrompt ? LEAN_SYSTEM_PROMPT : BASE_SYSTEM_PROMPT);

  // 1b. Agent policy — hard rules injected for every agent
  staticSections.push(AGENT_POLICY);

  // 2. Role-specific prompt — normalizeRole handles display-name variants ("Code Reviewer" → "reviewer")
  const roleKey = normalizeRole(ctx.role);
  if (roleKey && ROLE_PROMPTS[roleKey]) {
    staticSections.push(ROLE_PROMPTS[roleKey]!);
  }

  // 3. Custom prompt override
  if (ctx.customPrompt) {
    staticSections.push(`## Custom Instructions\n\n${ctx.customPrompt}`);
  }

  // ── Dynamic sections (change per session/turn) ──

  // 3b. Working directory — per-agent, so it lives in the dynamic tail (moved
  // out of BASE_SYSTEM_PROMPT 2026-07-15) to keep the static head shared.
  dynamicSections.push(`## Working Directory\nYour current working directory is: ${ctx.cwd}`);

  // 4. Git context — skip on lean conversational seats. Workspace git status
  // is volatile and a single changed line here busts SuperGrok prefix cache.
  if (!isLeanConversationalEnv() && await isGitRepo(ctx.cwd)) {
    const branch = await getGitBranch(ctx.cwd);
    const status = await getGitStatus(ctx.cwd);
    if (branch || status) {
      dynamicSections.push(`## Git Context\nBranch: ${branch}\n${status ? `Status:\n${status}` : ''}`);
    }
  }

  // 5. Memory (CLAUDE.md, .shizuha/memory.md)
  const memory = await loadMemory(ctx.cwd);
  if (memory) {
    dynamicSections.push(`## Project Memory\n\n${prepareProjectMemoryForPrompt(memory, maxProjectMemoryChars, 'Project memory')}`);
  }

  // 6. Tool list
  const promptTools = ctx.deferredMcpTools
    ? ctx.tools.filter((tool) => !tool.name.startsWith('mcp__'))
    : ctx.tools;
  if (includeToolListInPrompt && promptTools.length > 0) {
    const toolList = promptTools.map((t) => `- **${t.name}**: ${t.description}`).join('\n');
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
