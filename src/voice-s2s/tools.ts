import { isLeanConversationalEnv, LEAN_CONVERSATIONAL_MCP_TOOL_NAMES } from '../platform/lean-conversational.js';
import type { ToolDefinition } from '../tools/types.js';
import { toolsToRealtimeFunctions, type RealtimeFunctionTool } from '../provider/grok-voice.js';

/** Builtins that belong on the first Live S2S surface (same registry as text). */
export const VOICE_S2S_BUILTIN_TOOLS = ['bash', 'web_search', 'web_fetch'] as const;

/** Coding-agent Live floor for Shizuha Desktop / Code. Not the CEO Office MCP set. */
export const CODE_VOICE_S2S_BUILTIN_TOOLS = [
  'bash',
  'read',
  'write',
  'edit',
  'glob',
  'grep',
  'web_fetch',
  'web_search',
] as const;

export type VoiceS2SProfile = 'lean' | 'code';

const MCP_NAME = /^mcp__shizuha-[^_]+__(.+)$/;

/** `mcp__shizuha-pulse__pulse_get_my_tasks` → `pulse_get_my_tasks`. */
export function shortVoiceToolName(name: string): string {
  const match = name.match(MCP_NAME);
  return match?.[1] || name;
}

export function resolveVoiceS2SProfile(
  env: NodeJS.ProcessEnv = process.env,
  explicit?: VoiceS2SProfile,
): VoiceS2SProfile {
  if (explicit === 'lean' || explicit === 'code') return explicit;
  return isLeanConversationalEnv(env) ? 'lean' : 'code';
}

export function voiceS2SToolAllowlist(
  profile: VoiceS2SProfile = resolveVoiceS2SProfile(),
): Set<string> {
  if (profile === 'code') return new Set<string>(CODE_VOICE_S2S_BUILTIN_TOOLS);
  return new Set<string>([...LEAN_CONVERSATIONAL_MCP_TOOL_NAMES, ...VOICE_S2S_BUILTIN_TOOLS]);
}

export function isVoiceS2SToolName(name: string, allow = voiceS2SToolAllowlist()): boolean {
  if (allow.has(name) || allow.has(shortVoiceToolName(name))) return true;
  for (const item of allow) {
    if (shortVoiceToolName(item) === name) return true;
  }
  return false;
}

/**
 * Live-safe subset of the agent's real ToolRegistry.
 * Short names are unique; collisions keep the full MCP name.
 */
export function selectVoiceS2STools(
  defs: ToolDefinition[],
  opts?: { profile?: VoiceS2SProfile },
): ToolDefinition[] {
  const allow = voiceS2SToolAllowlist(resolveVoiceS2SProfile(process.env, opts?.profile));
  return shortenUniqueVoiceToolNames(defs.filter((def) => isVoiceS2SToolName(def.name, allow)));
}

export function shortenUniqueVoiceToolNames(defs: ToolDefinition[]): ToolDefinition[] {
  const shortCounts = new Map<string, number>();
  for (const def of defs) {
    const short = shortVoiceToolName(def.name);
    shortCounts.set(short, (shortCounts.get(short) ?? 0) + 1);
  }
  return defs.map((def) => {
    const short = shortVoiceToolName(def.name);
    if (short !== def.name && (shortCounts.get(short) ?? 0) === 1) {
      return { ...def, name: short };
    }
    return def;
  });
}

export function advertiseVoiceS2STools(defs: ToolDefinition[]): RealtimeFunctionTool[] {
  return toolsToRealtimeFunctions(shortenUniqueVoiceToolNames(defs));
}

export function resolveVoiceS2SToolName(available: string[], requested: string): string | null {
  if (available.includes(requested)) return requested;
  const matches = available.filter((name) => shortVoiceToolName(name) === requested);
  return matches.length === 1 ? matches[0]! : null;
}

export function clipVoiceToolOutput(text: string, maxChars = 8_000): string {
  const body = (text || '').trim();
  if (body.length <= maxChars) return body || '(empty)';
  return `${body.slice(0, maxChars)}\n…(truncated)`;
}
