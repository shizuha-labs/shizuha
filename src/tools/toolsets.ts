/**
 * Toolset system — named groups of tools for different contexts.
 *
 * Different channels or agents can use different toolsets. For example,
 * a Telegram bot might only get safe/read-only tools, while the CLI
 * gets everything. Toolsets are applied once at init time by filtering
 * the ToolRegistry.
 */

import { logger } from '../utils/logger.js';

// ── Types ──

export interface Toolset {
  name: string;
  description?: string;
  /** Tool names to include. '*' means all. Supports glob patterns like 'mcp__*' */
  include: string[];
  /** Tool names to exclude (applied after include) */
  exclude?: string[];
}

// ── Built-in Toolsets ──

// Common builtin tool groups (used by role-based profiles below)
const READ_TOOLS = ['read', 'glob', 'grep', 'web_fetch', 'web_search', 'pdf_extract', 'session_search', 'memory', 'usage_stats', 'ask_user'];
const WRITE_TOOLS = ['write', 'edit', 'bash', 'notebook', 'apply_patch'];
const TASK_TOOLS = ['task', 'todo_write', 'todo_read', 'task_output', 'task_stop', 'enter_plan_mode', 'exit_plan_mode', 'update_plan'];
const SCHEDULE_TOOLS = ['schedule_job', 'list_jobs', 'remove_job'];

// MCP server patterns per role (mirrors CLAUDE.md access matrix)
const MCP_COMMON = ['mcp__pulse*', 'mcp__wiki*', 'mcp__drive*'];
const MCP_ALL_SERVICES = [
  ...MCP_COMMON, 'mcp__admin*', 'mcp__id*', 'mcp__notes*', 'mcp__mail*',
  'mcp__inventory*', 'mcp__books*', 'mcp__finance*', 'mcp__hr*',
  'mcp__time*', 'mcp__connect*', 'mcp__scs*',
];

export const BUILTIN_TOOLSETS: Record<string, Toolset> = {
  // ── Generic toolsets ──
  'full': {
    name: 'full',
    description: 'All tools (CLI/autonomous mode)',
    include: ['*'],
  },
  'safe': {
    name: 'safe',
    description: 'Read-only tools only (plan mode)',
    include: ['read', 'glob', 'grep', 'web_fetch', 'web_search', 'session_search', 'usage_stats', 'memory', 'pdf_extract'],
  },
  'messaging': {
    name: 'messaging',
    description: 'Tools suitable for messaging channels (Telegram, Discord, WhatsApp)',
    include: ['*'],
    exclude: ['bash', 'write', 'edit', 'notebook', 'browser'],
  },
  'developer': {
    name: 'developer',
    description: 'Development-focused tools',
    include: ['read', 'write', 'edit', 'glob', 'grep', 'bash', 'notebook', 'web_fetch', 'web_search', 'session_search'],
  },
  'local': {
    name: 'local',
    description: 'Minimal tools for on-device local models (low context overhead)',
    include: ['bash', 'read', 'write', 'edit', 'glob', 'grep'],
  },
  'none': {
    name: 'none',
    description: 'No tools — pure chat mode (zero token overhead)',
    include: [],
  },

  // ── Role-based profiles (maps to CLAUDE.md agent roles + MCP access matrix) ──
  'architect': {
    name: 'architect',
    description: 'System design, HLD, API contracts — read-only builtins + pulse/wiki/drive/admin MCP',
    include: [...READ_TOOLS, ...TASK_TOOLS, ...MCP_COMMON, 'mcp__admin*'],
  },
  'engineer': {
    name: 'engineer',
    description: 'Full-stack development — all builtins + all MCP servers',
    include: ['*'],
  },
  'qa_engineer': {
    name: 'qa_engineer',
    description: 'User-perspective testing — read tools + browser, no code writes. pulse/wiki/drive MCP only',
    include: [...READ_TOOLS, ...TASK_TOOLS, 'browser', ...MCP_COMMON],
  },
  'security_engineer': {
    name: 'security_engineer',
    description: 'Security audits, pen testing — read tools + bash + browser. pulse/wiki/drive/id/scs MCP',
    include: [...READ_TOOLS, ...TASK_TOOLS, 'bash', 'browser', ...MCP_COMMON, 'mcp__id*', 'mcp__scs*'],
  },
  'technical_writer': {
    name: 'technical_writer',
    description: 'Documentation, wiki, research — read + write tools. pulse/wiki/drive/notes/browser MCP',
    include: [...READ_TOOLS, ...TASK_TOOLS, 'write', 'edit', 'browser', ...MCP_COMMON, 'mcp__notes*'],
  },
  'data_analyst': {
    name: 'data_analyst',
    description: 'Data analysis, reporting — read tools + bash + browser. All data service MCPs',
    include: [
      ...READ_TOOLS, ...TASK_TOOLS, 'bash', 'browser',
      ...MCP_COMMON, 'mcp__books*', 'mcp__finance*', 'mcp__hr*',
      'mcp__time*', 'mcp__inventory*',
    ],
  },
};

// ── Glob Matching ──

/**
 * Simple glob matching — supports '*' wildcard and prefix matching.
 * Mirrors the pattern used in permissions/engine.ts and hooks/engine.ts.
 */
function matchGlob(pattern: string, value: string): boolean {
  if (pattern === '*') return true;
  if (pattern === value) return true;
  // Trailing wildcard: 'mcp__*' matches 'mcp__pulse__list_tasks'
  if (pattern.endsWith('*') && value.startsWith(pattern.slice(0, -1))) return true;
  // mcp__ prefix matching: 'mcp__pulse' matches 'mcp__pulse__list_tasks'
  if (pattern.startsWith('mcp__') && value.startsWith(pattern)) return true;
  return false;
}

// ── ToolsetManager ──

export class ToolsetManager {
  private toolsets = new Map<string, Toolset>();

  constructor() {
    // Seed with built-in toolsets
    for (const [name, toolset] of Object.entries(BUILTIN_TOOLSETS)) {
      this.toolsets.set(name, toolset);
    }
  }

  /** Register a custom toolset (overwrites if name already exists) */
  register(toolset: Toolset): void {
    this.toolsets.set(toolset.name, toolset);
    logger.debug({ toolset: toolset.name }, 'Toolset registered');
  }

  /** Get a toolset by name */
  get(name: string): Toolset | undefined {
    return this.toolsets.get(name);
  }

  /** List all available toolsets */
  list(): Toolset[] {
    return [...this.toolsets.values()];
  }

  /**
   * Filter tool names by toolset. Returns the tool names that match the
   * toolset's include patterns minus exclude patterns.
   *
   * @param toolsetName Name of the toolset to apply
   * @param allToolNames All registered tool names
   * @returns Tool names that should remain active
   */
  filterTools(toolsetName: string, allToolNames: string[]): string[] {
    const toolset = this.toolsets.get(toolsetName);
    if (!toolset) {
      logger.warn({ toolset: toolsetName }, 'Unknown toolset, returning all tools');
      return allToolNames;
    }

    // Step 1: Include — collect tools matching any include pattern
    let included: string[];
    if (toolset.include.length === 1 && toolset.include[0] === '*') {
      // Fast path: include everything
      included = [...allToolNames];
    } else {
      included = allToolNames.filter((name) =>
        toolset.include.some((pattern) => matchGlob(pattern, name)),
      );
    }

    // Step 2: Exclude — remove tools matching any exclude pattern
    if (toolset.exclude && toolset.exclude.length > 0) {
      included = included.filter((name) =>
        !toolset.exclude!.some((pattern) => matchGlob(pattern, name)),
      );
    }

    logger.debug({
      toolset: toolsetName,
      total: allToolNames.length,
      included: included.length,
      excluded: allToolNames.length - included.length,
    }, 'Toolset filter applied');

    return included;
  }
}
