import { z } from 'zod';
import type { ToolHandler, ToolContext, ToolResult } from './types.js';
import { logger } from '../utils/logger.js';

// ── Types ──

export interface DeferredToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  serverName: string;
}

export interface MCPServerSummary {
  name: string;
  description: string;
  toolCount: number;
}

// ── Well-known Shizuha service descriptions ──

const KNOWN_DESCRIPTIONS: Record<string, string> = {
  pulse: 'task & project management',
  id: 'identity & authentication',
  admin: 'organization & team management',
  notes: 'personal note-taking',
  wiki: 'documentation & knowledge base',
  drive: 'file storage & sharing',
  notify: 'notifications & messaging',
  connect: 'social networking & posts',
  finance: 'personal finance & budgets',
  books: 'accounting & bookkeeping',
  hr: 'employees, leave & attendance',
  time: 'time tracking & timesheets',
  inventory: 'stock & warehouse management',
  mail: 'email send/receive/search',
  scs: 'cloud infrastructure management',
};

// ── BM25 Index (Okapi BM25) ──

/**
 * Pre-computed BM25 index for ranked full-text search over the tool catalog.
 *
 * Built once on setCatalog(), then queried per search. O(N × Q) per query
 * where N = catalog size and Q = query token count. Sub-millisecond for
 * catalogs up to ~10K tools.
 *
 * Each tool is tokenized into a virtual document with field boosting:
 * name parts repeated 2× and server parts repeated 2× to weight them
 * higher than description terms.
 */
class BM25Index {
  private docs: Array<{ tf: Map<string, number>; len: number }> = [];
  private df = new Map<string, number>(); // term → # of docs containing it
  private avgdl = 0; // average document length
  private N = 0; // total documents

  // Standard BM25 parameters (tuned for short tool descriptions)
  private static readonly k1 = 1.5; // TF saturation — higher = more TF influence
  private static readonly b = 0.75; // length normalization — 0 = none, 1 = full

  /** Build index from catalog. Called once when catalog is set. */
  build(catalog: DeferredToolInfo[]): void {
    this.N = catalog.length;
    this.df.clear();
    this.docs = [];
    let totalLen = 0;

    for (const tool of catalog) {
      const tokens = tokenizeDoc(tool);
      const tf = new Map<string, number>();
      for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
      for (const term of tf.keys()) this.df.set(term, (this.df.get(term) ?? 0) + 1);
      const len = tokens.length;
      this.docs.push({ tf, len });
      totalLen += len;
    }

    this.avgdl = this.N > 0 ? totalLen / this.N : 1;
  }

  /**
   * Score all documents against query tokens.
   * Returns Float64Array parallel to catalog (index i = catalog[i] score).
   */
  score(queryTokens: string[]): Float64Array {
    const scores = new Float64Array(this.N);
    if (this.N === 0 || queryTokens.length === 0) return scores;

    // Deduplicate query tokens (BM25 standard: each unique term scored once)
    const seen = new Set<string>();
    const unique: string[] = [];
    for (const t of queryTokens) {
      if (!seen.has(t)) { seen.add(t); unique.push(t); }
    }

    const { k1, b } = BM25Index;

    for (const qt of unique) {
      const n = this.df.get(qt) ?? 0;
      if (n === 0) continue; // term not in any document — skip
      // IDF: Robertson-Sparck Jones formula with floor at 0
      const idf = Math.log((this.N - n + 0.5) / (n + 0.5) + 1);

      for (let i = 0; i < this.N; i++) {
        const tf = this.docs[i].tf.get(qt) ?? 0;
        if (tf === 0) continue;
        const dl = this.docs[i].len;
        scores[i] += idf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * dl / this.avgdl));
      }
    }

    return scores;
  }
}

// ── Tokenization ──

/**
 * Tokenize a tool into searchable terms with field boosting.
 *
 * Field boosting via repetition:
 * - Name parts 2× (tool name is the strongest signal)
 * - Server name parts 2× (server scoping is high value)
 * - Description words 1× (supporting context)
 *
 * This naturally causes BM25's TF component to weight name/server matches
 * higher while keeping a single unified index.
 */
function tokenizeDoc(tool: DeferredToolInfo): string[] {
  const tokens: string[] = [];

  // Name: mcp__inventory__list_items → [inventory, list, items]
  const nameParts = tool.name.toLowerCase()
    .split(/[_]+/)
    .filter(t => t.length > 1 && t !== 'mcp');
  tokens.push(...nameParts, ...nameParts); // 2× boost

  // Server name
  const serverParts = tool.serverName.toLowerCase()
    .split(/[\s_\-]+/)
    .filter(t => t.length > 1);
  tokens.push(...serverParts, ...serverParts); // 2× boost

  // Description — split on non-alphanumeric
  const descParts = tool.description.toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(t => t.length > 1);
  tokens.push(...descParts); // 1×

  return tokens;
}

// ── ToolSearchState ──

/**
 * Manages deferred MCP tool catalog and session-level discovery state.
 *
 * All MCP tools are registered in the ToolRegistry for execution, but only
 * discovered tools have their definitions sent to the LLM. The LLM calls
 * ToolSearch to find tools → they become available on the next turn.
 *
 * Search uses a **BM25 + regex union** strategy:
 * - BM25: proper ranked retrieval with IDF weighting + length normalization
 * - Regex: substring matching for partial queries BM25 can't handle
 * - Union: merge both result sets so we never miss relevant tools
 *
 * Deferred tool search — dynamically loads tool definitions on demand.
 * Works with any LLM provider.
 */
export class ToolSearchState {
  private catalog: DeferredToolInfo[] = [];
  private discovered = new Set<string>();
  private servers: MCPServerSummary[] = [];
  private bm25 = new BM25Index();

  /** Populate the catalog from all MCP tools and server info */
  setCatalog(tools: DeferredToolInfo[], servers: MCPServerSummary[]): void {
    this.catalog = tools;
    this.servers = servers;
    this.bm25 = new BM25Index();
    this.bm25.build(tools);
    logger.debug({ catalogSize: tools.length, servers: servers.length }, 'BM25 index built');
  }

  /** Mark tools as discovered — they'll get full schemas on next turn */
  markDiscovered(toolNames: string[]): void {
    for (const name of toolNames) this.discovered.add(name);
  }

  /** Get set of discovered tool names */
  getDiscovered(): Set<string> {
    return this.discovered;
  }

  /** Get MCP server summaries for system prompt awareness */
  getServers(): MCPServerSummary[] {
    return this.servers;
  }

  /** Total tools in catalog */
  get catalogSize(): number {
    return this.catalog.length;
  }

  /** Get all tool names + descriptions in the catalog (for 'tools' awareness mode) */
  getCatalogToolNames(): Array<{ name: string; description: string; serverName: string }> {
    return this.catalog.map((t) => ({ name: t.name, description: t.description, serverName: t.serverName }));
  }

  /** Estimate tokens for all MCP tool definitions (name + desc + schema) */
  estimateCatalogTokens(): number {
    return this.catalog.reduce((sum, t) => {
      const schemaStr = JSON.stringify(t.inputSchema);
      return sum + Math.ceil((t.name.length + t.description.length + schemaStr.length) / 4);
    }, 0);
  }

  /** Check if tool search should be auto-enabled based on token threshold */
  shouldAutoEnable(maxContextTokens: number, thresholdPercent: number): boolean {
    const tokens = this.estimateCatalogTokens();
    const threshold = (maxContextTokens * thresholdPercent) / 100;
    logger.debug(
      { catalogTokens: tokens, threshold, thresholdPercent, catalogSize: this.catalog.length },
      'Tool search auto-enable check',
    );
    return tokens >= threshold;
  }

  /**
   * Search the catalog using BM25 + regex union.
   *
   * Supports three modes:
   * - "select:tool_name" or "select:name1,name2" — direct selection (bypass search)
   * - "+keyword term" — required keyword filter + ranked search
   * - "keyword term" — ranked search (BM25 + regex union)
   *
   * The union approach ensures we never miss relevant tools:
   * - BM25 excels at: term importance (IDF), multi-word ranking, length normalization
   * - Regex excels at: partial/substring matches (e.g., "inv" → "inventory"),
   *   exact server name matching, field-specific boosting
   */
  search(query: string, maxResults = 5): DeferredToolInfo[] {
    // ── Direct selection mode ──
    if (query.startsWith('select:')) {
      const names = query.slice(7).split(',').map((n) => n.trim());
      return this.catalog.filter((t) => names.includes(t.name));
    }

    // ── Parse query ──
    const rawTokens = query.toLowerCase().split(/[\s_\-:]+/).filter((t) => t.length > 0);
    if (rawTokens.length === 0) return [];

    const required: string[] = [];
    const optional: string[] = [];
    for (const t of rawTokens) {
      if (t.startsWith('+') && t.length > 1) {
        required.push(t.slice(1));
      } else {
        optional.push(t);
      }
    }
    const allTokens = [...required, ...optional];

    // ── BM25 scoring ──
    // Tokenize query with same strategy as documents (split on non-alpha boundaries)
    const bm25Tokens = allTokens
      .flatMap((t) => t.split(/[^a-z0-9]+/))
      .filter((t) => t.length > 1);
    const bm25Scores = this.bm25.score(bm25Tokens);

    // ── Regex/substring scoring ──
    // Catches partial matches BM25 misses and provides field-specific weighting
    const regexScores = new Float64Array(this.catalog.length);
    for (let i = 0; i < this.catalog.length; i++) {
      const tool = this.catalog[i];
      const nameLC = tool.name.toLowerCase();
      const descLC = tool.description.toLowerCase();
      const serverLC = tool.serverName.toLowerCase();

      let score = 0;
      for (const token of allTokens) {
        // Name match — strongest signal
        if (nameLC.includes(token)) score += 2;
        else if (descLC.includes(token)) score += 1;
        // Server match — high value for scoping
        if (serverLC === token) score += 3;
        else if (serverLC.includes(token)) score += 1;
      }
      regexScores[i] = score;
    }

    // ── Normalize both to [0, 1] ──
    let bm25Max = 0;
    let regexMax = 0;
    for (let i = 0; i < this.catalog.length; i++) {
      if (bm25Scores[i] > bm25Max) bm25Max = bm25Scores[i];
      if (regexScores[i] > regexMax) regexMax = regexScores[i];
    }
    const bm25Div = bm25Max || 1;
    const regexDiv = regexMax || 1;

    // ── Union merge: combine normalized scores ──
    // A tool found by both methods scores up to 2.0 (very relevant)
    // A tool found by only one scores up to 1.0 (still included — never miss)
    const results: Array<{ tool: DeferredToolInfo; score: number }> = [];
    for (let i = 0; i < this.catalog.length; i++) {
      const bm25Norm = bm25Scores[i] / bm25Div;
      const regexNorm = regexScores[i] / regexDiv;
      const combined = bm25Norm + regexNorm;
      if (combined <= 0) continue;

      // Required token filter — all must appear in searchable text
      if (required.length > 0) {
        const tool = this.catalog[i];
        const searchText = `${tool.name.toLowerCase()} ${tool.description.toLowerCase()} ${tool.serverName.toLowerCase()}`;
        if (!required.every((r) => searchText.includes(r))) continue;
      }

      results.push({ tool: this.catalog[i], score: combined });
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, maxResults).map((s) => s.tool);
  }
}

// ── ToolSearch Built-in Tool ──

/**
 * Create the ToolSearch built-in tool.
 *
 * This is the client-side equivalent of Claude Code's server-side
 * tool_search_tool_regex. It works with any LLM provider.
 *
 * The LLM calls this tool to discover MCP tools. Discovered tools
 * are added to the tools array on the next turn.
 */
export function createToolSearchTool(state: ToolSearchState): ToolHandler {
  return {
    name: 'ToolSearch',
    description:
      'Search for or select deferred tools to make them available for use. ' +
      'Use keywords to search (e.g., "inventory list items") or "select:tool_name" for direct selection. ' +
      'Prefix with + to require a match (e.g., "+pulse create task"). ' +
      'Found tools become available on your next action.',
    parameters: z.object({
      query: z.string().describe(
        'Search keywords or "select:tool_name" for direct selection. Use + prefix to require a term.',
      ),
      max_results: z.number().int().min(1).max(10).default(5).describe(
        'Maximum number of results to return (default: 5)',
      ),
    }),
    readOnly: true,
    riskLevel: 'low',

    async execute(params: unknown, _context: ToolContext): Promise<ToolResult> {
      const { query, max_results } = params as { query: string; max_results?: number };
      const results = state.search(query, max_results ?? 5);

      if (results.length === 0) {
        const servers = state.getServers();
        const serverList = servers.map((s) => `${s.name} (${s.toolCount} tools)`).join(', ');
        return {
          toolUseId: '',
          content: `No tools found matching "${query}". Available servers: ${serverList}. Try different keywords.`,
        };
      }

      // Mark as discovered — they'll be in the tools array next turn
      state.markDiscovered(results.map((t) => t.name));

      // Format: summary + full schemas
      const summary = results
        .map((t) => `- **${t.name}** (${t.serverName}): ${t.description}`)
        .join('\n');

      const schemas = results.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      }));

      return {
        toolUseId: '',
        content:
          `Found ${results.length} tool(s). They are now available for use:\n\n` +
          `${summary}\n\nSchemas:\n${JSON.stringify(schemas, null, 2)}`,
      };
    },
  };
}

// ── Helpers ──

/** Build MCP server summaries from connection data */
export function buildServerSummaries(
  connections: Map<string, { tools: Array<{ name: string }>; instructions?: string }>,
): MCPServerSummary[] {
  const summaries: MCPServerSummary[] = [];
  for (const [name, conn] of connections) {
    const normalizedName = name.startsWith('shizuha-') ? name.slice(8) : name;
    summaries.push({
      name,
      description: conn.instructions?.slice(0, 100) ?? KNOWN_DESCRIPTIONS[normalizedName] ?? '',
      toolCount: conn.tools.length,
    });
  }
  return summaries;
}

/** Build deferred tool catalog from MCP tool list */
export function buildToolCatalog(
  tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>,
): DeferredToolInfo[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
    serverName: t.name.split('__')[1] ?? '',
  }));
}

/**
 * Build the awareness section for the system prompt.
 *
 * Modes:
 * - 'none': empty string
 * - 'servers': MCP server names + one-line descriptions
 * - 'tools': full tool name listing (original Layer 3)
 */
export function buildAwarenessPrompt(
  mode: 'none' | 'servers' | 'tools',
  state: ToolSearchState,
): string {
  if (mode === 'none') return '';

  if (mode === 'servers') {
    const servers = state.getServers();
    if (servers.length === 0) return '';
    const lines = servers
      .map((s) => `- **${s.name}**: ${s.description || s.name} (${s.toolCount} tools)`)
      .join('\n');
    return (
      `## Available MCP Servers\n\n` +
      `Use ToolSearch to find and load specific tools from these servers:\n\n${lines}`
    );
  }

  // mode === 'tools' — list all individual tool names (no schemas)
  const allTools = state.getCatalogToolNames();
  if (allTools.length === 0) return '';

  const lines = allTools
    .map((t) => `- \`${t.name}\`: ${t.description}`)
    .join('\n');
  return (
    `## Available MCP Tools\n\n` +
    `Use ToolSearch to load specific tools before use:\n\n${lines}`
  );
}
