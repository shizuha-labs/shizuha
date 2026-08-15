import type { PermissionRule } from './types.js';

/** Parse permission rules from TOML config format */
export function parseRules(
  raw: Array<{ tool: string; pattern?: string; decision: string }>,
): PermissionRule[] {
  return raw.map((r) => ({
    tool: r.tool,
    pattern: r.pattern,
    decision: r.decision as PermissionRule['decision'],
  }));
}

/** Default rules for supervised mode */
export const DEFAULT_RULES: PermissionRule[] = [
  // Read-only tools always allowed
  { tool: 'read', decision: 'allow' },
  { tool: 'glob', decision: 'allow' },
  { tool: 'grep', decision: 'allow' },
  { tool: 'ask_user', decision: 'allow' },
  // Write tools need approval
  { tool: 'write', decision: 'ask' },
  { tool: 'edit', decision: 'ask' },
  { tool: 'bash', decision: 'ask' },
  // Web tools
  { tool: 'web_fetch', decision: 'allow' },
  { tool: 'web_search', decision: 'allow' },
];
