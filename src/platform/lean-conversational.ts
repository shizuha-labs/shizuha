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
  'mcp__shizuha-pulse__pulse_add_comment',
  'mcp__shizuha-pulse__pulse_assign_task',
  'mcp__shizuha-pulse__pulse_create_task',
  'mcp__shizuha-pulse__pulse_execute_transition',
  'mcp__shizuha-pulse__pulse_get_my_alerts',
  'mcp__shizuha-pulse__pulse_get_my_tasks',
  'mcp__shizuha-pulse__pulse_get_task',
  'mcp__shizuha-pulse__pulse_get_user_tasks',
  'mcp__shizuha-pulse__pulse_search_tasks',
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
  const raw = (env['SHIZUHA_CONNECT_AUTOREPLY'] ?? '').trim();
  if (raw === '0' || raw === 'false' || raw === 'off') return false;
  if (raw === '1' || raw === 'true' || raw === 'on') return true;
  return isLeanConversationalEnv(env);
}

export function leanConversationalSkillNames(env: NodeJS.ProcessEnv = process.env): string[] {
  const configured = (env['AGENT_SKILLS'] ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  return [...new Set([...LEAN_CONVERSATIONAL_SKILLS, ...configured])].sort();
}
