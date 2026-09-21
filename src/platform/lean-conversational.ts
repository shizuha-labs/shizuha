/**
 * CEO Office resident talk seats (Hina/Aya/Yuna/Ena).
 *
 * Operator 2026-08-16: these seats are proper fleet agents — same Pulse /
 * Connect / Wiki / Admin / ID / Hive class as Shizuha and admin-ops. The
 * 2026-08-15 SuperGrok-cache contract (empty tools[], no Hive, one-shot
 * turns) made them narrate lookups they could not perform. Heartbeats stay
 * a long-idle fallback, not a 5-minute poll.
 */

export const DEFAULT_IDLE_HEARTBEAT_MS = 30 * 60 * 1000;
export const DEFAULT_HEARTBEAT_DEBOUNCE_MS = 30 * 60 * 1000;
export const DEFAULT_FIRST_HEARTBEAT_MS = 30 * 60 * 1000;
/** Silent prefix-cache warm after boot for resident talk seats. Idle stays 30m. */
export const LEAN_FIRST_HEARTBEAT_MS = 8_000;
/** Work-agent first beat — Hive injects this; firstWarmTimer must honor it. */
export const WORK_FIRST_HEARTBEAT_MS = 8_000;
/**
 * Operator directive 2026-09-15: honor the seat's configured idle heartbeat
 * cadence (fleet work agents run 90s) — the 2026-09-14 "treat <5m as stale"
 * clamp silenced the fleet (30m default, 1/16 admitted with ready work
 * queued). Sub-minute values still fall back to the default; the banto spin
 * class is prevented by the fast-rearm no-progress cap and loop-break
 * fallback, not by starving the work-seeking beat.
 */
export function resolveIdleHeartbeatMs(
  raw: string | undefined,
  fallback: number = DEFAULT_IDLE_HEARTBEAT_MS,
): number {
  const n = Number(raw ?? fallback);
  if (!Number.isFinite(n) || n < 60_000) return fallback;
  return n;
}

/**
 * Exact tools[] names for Pulse MCP.
 *
 * `listMCPToolsInternal` prefixes `mcp__${serverName}__${native}`. glm47
 * `validate_tool_names` is an exact string match against that offered name.
 * Model-visible strings (prompts, heartbeat stubs, incomplete-turn recovery)
 * MUST use these, never the bare suffix (`pulse_add_comment`). Teaching both
 * vocabularies makes GLM emit short/aliased/mashed names that the parser
 * drops.
 */
export const PULSE_MCP_TOOL = {
  getMyWork: 'mcp__shizuha-pulse__pulse_get_my_work',
  getMyTasks: 'mcp__shizuha-pulse__pulse_get_my_tasks',
  getMyAlerts: 'mcp__shizuha-pulse__pulse_get_my_alerts',
  getTask: 'mcp__shizuha-pulse__pulse_get_task',
  executeTransition: 'mcp__shizuha-pulse__pulse_execute_transition',
  addComment: 'mcp__shizuha-pulse__pulse_add_comment',
  listComments: 'mcp__shizuha-pulse__pulse_list_comments',
  assignTask: 'mcp__shizuha-pulse__pulse_assign_task',
  createTask: 'mcp__shizuha-pulse__pulse_create_task',
  searchTasks: 'mcp__shizuha-pulse__pulse_search_tasks',
  getUserTasks: 'mcp__shizuha-pulse__pulse_get_user_tasks',
} as const;

/** Pulse tools the work-agent heartbeat tells the model to call without ToolSearch.
 *  They must sit on the Direct tools[] head so the announced name equals the
 *  call name (operator 2026-09-14: announce-exact / return-exact). DeepSeek's
 *  append-only head otherwise leaves get_my_work undeclared; live 2026-08-17
 *  holders then ended the turn silent (queue-blind, Admitted 1/8). get_task /
 *  execute_transition / add_comment were the next class: stubs said "call
 *  pulse_add_comment" while tools[] only announced get_my_work. */
export const WORK_HEARTBEAT_MCP_TOOL_NAMES = [
  PULSE_MCP_TOOL.getMyWork,
  PULSE_MCP_TOOL.getTask,
  PULSE_MCP_TOOL.executeTransition,
  PULSE_MCP_TOOL.addComment,
] as const;

export const LEAN_CONVERSATIONAL_TEAMS = new Set(['ceo-office']);
export const LEAN_CONVERSATIONAL_USERNAMES = new Set(['hina', 'aya', 'yuna', 'ena']);

/** MCP servers every CEO Office talk seat must keep connected. */
export const LEAN_CONVERSATIONAL_MCP = [
  'pulse', 'connect', 'wiki', 'admin', 'id', 'hive',
] as const;

/** Nothing is trimmed off the platform floor for CEO Office anymore. */
export const LEAN_TRIMMABLE_PLATFORM_MCP = new Set<string>();

/**
 * Declared MCP tool head pre-activated at boot so hosted SuperGrok can call
 * work tools without a ToolSearch round-trip. This is a floor, not a ceiling
 * — later mentions may still activate more connected MCP tools.
 */
export const LEAN_CONVERSATIONAL_MCP_TOOL_NAMES = [
  'mcp__shizuha-admin__admin_list_teams',
  'mcp__shizuha-connect__message_user',
  'mcp__shizuha-hive__hive_get_agent_roster',
  'mcp__shizuha-hive__hive_list_fleet_agents',
  PULSE_MCP_TOOL.addComment,
  PULSE_MCP_TOOL.assignTask,
  PULSE_MCP_TOOL.createTask,
  PULSE_MCP_TOOL.executeTransition,
  PULSE_MCP_TOOL.getMyAlerts,
  PULSE_MCP_TOOL.getMyTasks,
  PULSE_MCP_TOOL.getMyWork,
  PULSE_MCP_TOOL.getTask,
  PULSE_MCP_TOOL.getUserTasks,
  PULSE_MCP_TOOL.searchTasks,
  'mcp__shizuha-wiki__wiki_get_page',
  'mcp__shizuha-wiki__wiki_search_pages',
] as const;

/** Catalog-only skills (one-liners, never inlined) for a lean seat. */
export const LEAN_CONVERSATIONAL_SKILLS = [
  'skill-loader',
  'connect-messaging',
  'heartbeat-protocol',
  'wiki-lifecycle',
  'personal-assistant',
  'company-os',
  'operator-request-hygiene',
] as const;

export function isLeanConversationalEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env['SHIZUHA_LEAN_MCP'] === '1') return true;
  const team = (env['AGENT_TEAM'] ?? '').trim().toLowerCase();
  if (LEAN_CONVERSATIONAL_TEAMS.has(team)) return true;
  const username = (env['AGENT_USERNAME'] ?? '').trim().toLowerCase();
  return LEAN_CONVERSATIONAL_USERNAMES.has(username);
}

/** Talk-minimal system prompt: tiny identity, no coding-agent lecture.
 *  Default OFF — CEO Office seats use the same AGENTS.md as other agents.
 *  Set SHIZUHA_TALK_MINIMAL_PROMPT=1 to opt back into the slim prompt,
 *  or =none for an empty/custom-only prompt. */
export function talkPromptMode(env: NodeJS.ProcessEnv = process.env): 'full' | 'minimal' | 'none' {
  const raw = (env['SHIZUHA_TALK_MINIMAL_PROMPT'] ?? '').trim().toLowerCase();
  if (raw === 'none' || raw === 'empty') return 'none';
  if (raw === '1' || raw === 'true' || raw === 'on' || raw === 'minimal') return 'minimal';
  return 'full';
}

/** Empty tools[] / tool_choice=none. Opt-in only — never the CEO Office default.
 *  The 2026-08-15 coupling to talk-minimal prompt made Ena narrate Pulse
 *  lookups she could not execute. */
export function talkSeatSuppressesTools(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env['SHIZUHA_TALK_SUPPRESS_TOOLS'] ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'on';
}

/** DeepSeek talk seats can disable thinking (live Cortex 200). grok-4.6/4.5
 *  cannot — xAI returns 400 for off/none/disabled. */
export function talkSeatDisablesThinking(
  modelName: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (talkPromptMode(env) === 'full') return false;
  const id = (modelName || '').toLowerCase();
  if (id.includes('grok-4.6') || id.includes('grok-4.5')) return false;
  return id.includes('deepseek');
}

/** Hard deadline for one talk-seat model call. Cortex keepalives otherwise
 *  leave a sequential turn open forever (Yuna T2, 2026-08-15). */
export function talkSeatTurnTimeoutMs(env: NodeJS.ProcessEnv = process.env): number | undefined {
  if (!talkSeatSuppressesTools(env)) return undefined;
  const raw = Number(env['SHIZUHA_TALK_TURN_MS'] ?? 12_000);
  return Number.isFinite(raw) && raw > 0 ? raw : 12_000;
}

export function connectAutoReplyEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const model = (
    env['MODEL'] || env['SHIZUHA_K8S_PRIMARY_MODEL'] || ''
  ).trim().toLowerCase();
  // Voice Think Fast replies as session text/audio and often never calls
  // message_user. Hive still pins SHIZUHA_CONNECT_AUTOREPLY=0 for grok-4.x
  // CEO Office seats to avoid the Replied. dual-write.
  if (model.includes('grok-voice')) return true;
  const raw = (env['SHIZUHA_CONNECT_AUTOREPLY'] ?? '').trim();
  if (raw === '0' || raw === 'false' || raw === 'off') return false;
  if (raw === '1' || raw === 'true' || raw === 'on') return true;
  // Default off — same contract as every other fleet agent: only
  // message_user delivers. Lean-env auto-relay dual-wrote Live turns
  // as the spoken sentence plus a leftover "Replied."
  return false;
}

export function leanConversationalSkillNames(env: NodeJS.ProcessEnv = process.env): string[] {
  const configured = (env['AGENT_SKILLS'] ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  return [...new Set([...LEAN_CONVERSATIONAL_SKILLS, ...configured])].sort();
}
