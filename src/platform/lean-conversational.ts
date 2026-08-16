/**
 * Lean conversational seats (CEO Office talkable agents).
 *
 * Operator 2026-08-15: keep the SuperGrok prefix slim and byte-stable so
 * prompt-cache hits stay at 100% on live talk. Heartbeats are a long-idle
 * fallback, not a 5-minute poll.
 */

export const DEFAULT_IDLE_HEARTBEAT_MS = 30 * 60 * 1000;
export const DEFAULT_HEARTBEAT_DEBOUNCE_MS = 30 * 60 * 1000;
export const DEFAULT_FIRST_HEARTBEAT_MS = 30 * 60 * 1000;
/** Silent prefix-cache warm after boot for lean talk seats. Idle stays 30m. */
export const LEAN_FIRST_HEARTBEAT_MS = 8_000;

export const LEAN_CONVERSATIONAL_TEAMS = new Set(['ceo-office']);
export const LEAN_CONVERSATIONAL_USERNAMES = new Set(['hina', 'aya', 'yuna', 'ena']);

/** MCP servers that stay connected for a lean conversational seat. */
export const LEAN_CONVERSATIONAL_MCP = ['pulse', 'connect', 'wiki'] as const;

/** Historical PLAT-1251 extras a lean seat must drop. */
export const LEAN_TRIMMABLE_PLATFORM_MCP = new Set(['admin', 'id', 'scs']);

/**
 * Declared MCP tool head for lean seats. Hosted SuperGrok only calls tools
 * present in the request `tools` array, so this set is the whole surface.
 *
 * Pulse work tools belong HERE from boot — not added mid-conversation.
 * SuperGrok cache keys the prefix including `tools[]`. Naming
 * pulse_get_my_tasks in a heartbeat is fine once those schemas are already
 * in this list; adding them later is the cache break.
 *
 * Keep this list append-never except as a coordinated prefix bump.
 */
export const LEAN_CONVERSATIONAL_MCP_TOOL_NAMES = [
  'mcp__shizuha-connect__message_user',
  'mcp__shizuha-pulse__pulse_add_comment',
  'mcp__shizuha-pulse__pulse_assign_task',
  'mcp__shizuha-pulse__pulse_create_task',
  'mcp__shizuha-pulse__pulse_execute_transition',
  'mcp__shizuha-pulse__pulse_get_my_alerts',
  'mcp__shizuha-pulse__pulse_get_my_tasks',
  'mcp__shizuha-pulse__pulse_get_task',
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

/** Talk-minimal system prompt: tiny identity, no coding-agent / AGENTS.md / tool list.
 *  Default ON for lean seats. Set SHIZUHA_TALK_MINIMAL_PROMPT=0 to disable,
 *  or =none for an empty/custom-only prompt. */
export function talkPromptMode(env: NodeJS.ProcessEnv = process.env): 'full' | 'minimal' | 'none' {
  const raw = (env['SHIZUHA_TALK_MINIMAL_PROMPT'] ?? '').trim().toLowerCase();
  if (raw === '0' || raw === 'false' || raw === 'off') return 'full';
  if (raw === 'none' || raw === 'empty') return 'none';
  if (raw === '1' || raw === 'true' || raw === 'on' || raw === 'minimal') return 'minimal';
  return isLeanConversationalEnv(env) ? 'minimal' : 'full';
}

/** Talk seats must not start a tool/recovery loop. A queued follow-up DM
 *  otherwise sits behind Pulse/wiki calls and looks like a dead turn. */
export function talkSeatSuppressesTools(env: NodeJS.ProcessEnv = process.env): boolean {
  return talkPromptMode(env) !== 'full';
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
