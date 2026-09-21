/**
 * ToolSearch — deferred tool discovery for the shizuha gateway.
 *
 * When the agent has many MCP tools (100+), sending all schemas to the LLM
 * consumes too much context (~100K tokens for 140 tools). Instead:
 * 1. Only tool NAMES are listed in a system-reminder message
 * 2. The model calls ToolSearch to fetch full schemas on demand
 * 3. After fetching, the tool becomes callable for the rest of the session
 *
 * This mirrors Claude Code's ToolSearch mechanism.
 */

import type { ToolHandler, ToolResult, ToolContext, ToolDefinition } from '../types.js';
import { z } from 'zod';
import { logger } from '../../utils/logger.js';
import { ToolSearchState } from '../tool-search.js';

// Registry of deferred tools (set by agent-process at init time)
let deferredTools = new Map<string, ToolDefinition>();
let deferredSchemas = new Map<string, Record<string, unknown>>(); // name → full JSON Schema
const searchState = new ToolSearchState();

// Callback to dynamically add resolved tools to the active tool definitions
// (so the LLM can call them on subsequent turns)
let onToolResolved: ((toolDef: ToolDefinition) => void) | null = null;

export function setOnToolResolved(callback: (toolDef: ToolDefinition) => void): void {
  onToolResolved = callback;
}

export function setDeferredTools(
  tools: Map<string, ToolDefinition>,
  schemas: Map<string, Record<string, unknown>>,
): void {
  deferredTools = tools;
  deferredSchemas = schemas;
  searchState.setCatalog([...tools.values()].map(tool => ({
    name: tool.name,
    description: tool.description,
    inputSchema: (schemas.get(tool.name)?.inputSchema ?? tool.inputSchema) as Record<string, unknown>,
    serverName: tool.name.split('__')[1] ?? '',
  })), []);
}

export function getDeferredToolNames(): string[] {
  return [...deferredTools.keys()];
}

export function getDeferredToolSchema(name: string): Record<string, unknown> | undefined {
  return deferredSchemas.get(name);
}

/** Resolve a deferred tool — returns its full definition for injection into the active tool set */
export function resolveDeferredTool(name: string): ToolDefinition | undefined {
  return deferredTools.get(name);
}

// 2026-07-14 (agent-jun, 3×57s turns): every mid-session tool activation rewrites
// the prompt-head tools array and busts the vLLM prefix cache — at a 100K+ context
// that is a full ~50-60s re-prefill PER activation. Agents typically discover a
// tool FAMILY across consecutive turns (upload_attachment, then download_attachment,
// then get_attachment…), paying the break N times. When a select: resolves a tool,
// co-activate its deferred same-server siblings that share a non-generic name token
// with it, so the whole family lands in ONE schema change. Capped to keep the
// context cost bounded (schemas are cached after the single break).
const CO_ACTIVATION_CAP = 8;
const GENERIC_NAME_TOKENS = new Set([
  'get', 'list', 'create', 'update', 'delete', 'add', 'remove', 'set',
  'search', 'all', 'my', 'by', 'the', 'a', 'of', 'to', 'admin', 'su',
]);

function familyTokens(toolName: string): Set<string> {
  const suffix = toolName.includes('__') ? toolName.slice(toolName.lastIndexOf('__') + 2) : toolName;
  // The server noun is usually repeated in every tool name (wiki_create_page,
  // wiki_upload_attachment, …) — it must not count as a family link or one
  // select would fan out to the whole server.
  const serverTokens = new Set(serverPrefixOf(toolName).split(/[_\-.]/).map(t => t.toLowerCase()));
  return new Set(suffix.split(/[_-]/).filter(
    t => t.length > 2 && !GENERIC_NAME_TOKENS.has(t) && !serverTokens.has(t.toLowerCase()),
  ));
}

function serverPrefixOf(toolName: string): string {
  const idx = toolName.lastIndexOf('__');
  return idx > 0 ? toolName.slice(0, idx) : '';
}

/** Co-activate deferred same-server siblings sharing a name token with `name`.
 *  Returns the co-activated tool names (empty when none / no callback). */
function coActivateFamily(name: string): string[] {
  if (!onToolResolved) return [];
  const server = serverPrefixOf(name);
  if (!server) return [];
  const tokens = familyTokens(name);
  if (tokens.size === 0) return [];
  const activated: string[] = [];
  for (const [candidate, def] of deferredTools) {
    if (activated.length >= CO_ACTIVATION_CAP) break;
    if (candidate === name || serverPrefixOf(candidate) !== server) continue;
    const candTokens = familyTokens(candidate);
    let shares = false;
    for (const t of candTokens) { if (tokens.has(t)) { shares = true; break; } }
    if (!shares) continue;
    onToolResolved(def);
    activated.push(candidate);
  }
  if (activated.length) {
    logger.info({ tool: name, coActivated: activated }, 'ToolSearch: co-activated tool family (single prefix-cache break)');
  }
  return activated;
}

const executeToolSearch = async (
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolResult> => {
  if (typeof input?.query !== 'string' || !input.query.trim()) {
    return {
      toolUseId: '',
      content: 'ToolSearch requires a non-empty string named "query". Use {"query":"pulse tasks"} or {"query":"select:mcp__server__tool"}. Fields named "queries" or "mode" do not replace "query".',
      isError: true,
    };
  }
  const query = input.query.trim();
  const maxResults = input.max_results ?? 3;
  if (typeof maxResults !== 'number' || !Number.isInteger(maxResults) || maxResults < 1) {
    return { toolUseId: '', content: 'ToolSearch "max_results" must be a positive integer.', isError: true };
  }

  // Direct selection: "select:tool_name" or "select:tool1,tool2"
  if (query.startsWith('select:')) {
    const names = query.slice(7).split(',').map(n => n.trim());
    const results: string[] = [];
    const allCoActivated: string[] = [];
    for (const name of names) {
      const schema = deferredSchemas.get(name);
      if (schema) {
        results.push(JSON.stringify({ name, ...schema }));
        // Activate the tool so the LLM can call it on subsequent turns
        const toolDef = deferredTools.get(name);
        if (toolDef && onToolResolved) onToolResolved(toolDef);
        logger.info({ tool: name }, 'ToolSearch: resolved deferred tool');
        allCoActivated.push(...coActivateFamily(name));
      } else {
        // Fuzzy match — try prefix
        const match = [...deferredSchemas.keys()].find(k => k.includes(name));
        if (match) {
          results.push(JSON.stringify({ name: match, ...deferredSchemas.get(match)! }));
          const toolDef = deferredTools.get(match);
          if (toolDef && onToolResolved) onToolResolved(toolDef);
          logger.info({ tool: match, query: name }, 'ToolSearch: fuzzy-matched deferred tool');
          allCoActivated.push(...coActivateFamily(match));
        } else {
          results.push(`Tool "${name}" not found in deferred tools.`);
        }
      }
    }
    let content = results.join('\n\n');
    if (allCoActivated.length) {
      content += `\n\nAlso activated ${allCoActivated.length} related tool(s) from the same family — already callable, no need to select them:\n${[...new Set(allCoActivated)].join('\n')}`;
    }
    return { toolUseId: '', content };
  }

  const top = searchState.search(query, maxResults);

  if (top.length === 0) {
    return {
      toolUseId: '',
      content: `No deferred tools found for "${query}". Total deferred: ${deferredTools.size}.`,
    };
  }

  const resultLines = top.map(tool => {
    const definition = deferredTools.get(tool.name);
    if (definition && onToolResolved) onToolResolved(definition);
    return JSON.stringify({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema });
  });

  return {
    toolUseId: '',
    content: `Found ${top.length} tool(s). These tools are ACTIVE immediately; call them directly by their exact names using the schemas below. No second ToolSearch selection is needed.\n\n${resultLines.join('\n\n')}`,
  };
};

export const toolSearchTool: ToolHandler = {
  name: 'ToolSearch',
  description:
    'Fetch full schema definitions for deferred tools so they can be called.\n' +
    'Deferred tools appear by name in system-reminder messages. Until fetched, only the name is known.\n' +
    'Query forms:\n' +
    '- "select:tool_name" — fetch exact tool by name\n' +
    '- "select:tool1,tool2" — fetch multiple tools\n' +
    '- "keyword search" — search by keyword, returns top matches\n' +
    'Selected tools become ACTIVE immediately — call them directly using the JSON schema ' +
    'returned in the result. Batch related selections into one call when convenient, and ' +
    're-select any time you need a schema again (selection is cheap).',
  parameters: z.object({
    query: z.string().min(1).describe('Query to find deferred tools. Use "select:<tool_name>" for direct selection, or keywords to search.'),
    max_results: z.number().int().positive().optional().default(3).describe('Maximum number of results to return (default: 3)'),
  }),
  readOnly: true,
  riskLevel: 'low',
  async execute(params: unknown, context: ToolContext): Promise<ToolResult> {
    return executeToolSearch(params as Record<string, unknown>, context);
  },
};
