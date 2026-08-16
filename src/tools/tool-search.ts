import { z } from 'zod';
import type { ToolHandler, ToolContext, ToolDefinition, ToolResult } from './types.js';
import { logger } from '../utils/logger.js';
import { isCortexModelId } from '../provider/registry.js';

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
  inventory: 'stock & warehouse management',
  mail: 'email send/receive/search',
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
        const doc = this.docs[i]!;
        const tf = doc.tf.get(qt) ?? 0;
        if (tf === 0) continue;
        const dl = doc.len;
        scores[i]! += idf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * dl / this.avgdl));
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
  /** Discovery order is part of the provider-prefix contract. A Set tells us
   *  membership, but rebuilding definitions in registry/alphabetical order can
   *  insert a later discovery before an earlier one and rewrite more of the
   *  provider's tool prefix. Keep the session order explicitly. */
  private discoveryOrder: string[] = [];
  private servers: MCPServerSummary[] = [];
  private bm25 = new BM25Index();

  /** Populate the catalog from all MCP tools and server info */
  setCatalog(tools: DeferredToolInfo[], servers: MCPServerSummary[]): void {
    // MCP connections are concurrent, so arrival order is not a stable prompt
    // contract. Name-sort the local search index and server catalog once.
    this.catalog = [...tools].sort((a, b) => a.name.localeCompare(b.name));
    this.servers = [...servers].sort((a, b) => a.name.localeCompare(b.name));
    this.bm25 = new BM25Index();
    this.bm25.build(this.catalog);
    logger.debug({ catalogSize: this.catalog.length, servers: this.servers.length }, 'BM25 index built');
  }

  /** Mark tools as discovered — they'll get full schemas on next turn */
  markDiscovered(toolNames: string[]): void {
    for (const name of toolNames) {
      if (this.discovered.has(name)) continue;
      this.discovered.add(name);
      this.discoveryOrder.push(name);
    }
  }

  /** Get set of discovered tool names */
  getDiscovered(): Set<string> {
    return this.discovered;
  }

  /** Exact first-discovery order, used by hosted-provider compatibility mode. */
  getDiscoveredInOrder(): readonly string[] {
    return this.discoveryOrder;
  }

  /**
   * Re-derive discovered tools from prior conversation — for SESSION RESUME.
   *
   * The discovered set lives only in memory, so a process restart (or daemon
   * recycle) wipes it. When a resumed transcript already shows tools that were
   * found via ToolSearch (or called directly), but `discovered` is empty,
   * getToolDefs() filters those MCP tools out of the tools array — so the model
   * "remembers" the tool from history yet can't actually call it, and weaker
   * models fall back to faking the call via `bash echo "<toolname>"`.
   *
   * Claude Code avoids this by rebuilding its discovered set from message
   * history on every request (extractDiscoveredToolNames). We do the same on
   * resume: scan the transcript for any catalog tool name that already appeared
   * (in a ToolSearch result or a prior tool_use) and re-mark it discovered.
   *
   * Returns the number of tools newly re-marked.
   */
  markDiscoveredFromHistory(messages: Array<{ content?: unknown }>): number {
    if (this.catalog.length === 0 || messages.length === 0) return 0;
    const names = new Set(this.catalog.map((t) => t.name));
    // Hyphen is included: shizuha server names are hyphenated (mcp__shizuha-pulse__...).
    const re = /mcp__[A-Za-z0-9_-]+/g;
    let added = 0;
    const scan = (text: string): void => {
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        const n = m[0];
        if (names.has(n) && !this.discovered.has(n)) {
          this.discovered.add(n);
          this.discoveryOrder.push(n);
          added++;
        }
      }
    };
    for (const msg of messages) {
      const c = msg?.content;
      if (typeof c === 'string') scan(c);
      else if (c != null) scan(JSON.stringify(c));
    }
    return added;
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
      const requested = query.slice(7)
        .split(',')
        .map(normalizeSelector)
        .filter((n) => n.length > 0);
      const selected: DeferredToolInfo[] = [];
      const seen = new Set<string>();

      for (const name of requested) {
        const exact = this.catalog.filter((t) => toolSelectorAliases(t).includes(name));
        const matches = exact.length > 0
          ? exact
          : this.catalog.filter((t) => toolSelectorAliases(t).some((alias) => alias.endsWith(`__${name}`) || alias.endsWith(`:${name}`)));

        for (const tool of matches) {
          if (seen.has(tool.name)) continue;
          seen.add(tool.name);
          selected.push(tool);
          if (selected.length >= maxResults) return selected;
        }
      }

      return selected;
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
      const tool = this.catalog[i]!;
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
      if (bm25Scores[i]! > bm25Max) bm25Max = bm25Scores[i]!;
      if (regexScores[i]! > regexMax) regexMax = regexScores[i]!;
    }
    const bm25Div = bm25Max || 1;
    const regexDiv = regexMax || 1;

    // ── Union merge: combine normalized scores ──
    // A tool found by both methods scores up to 2.0 (very relevant)
    // A tool found by only one scores up to 1.0 (still included — never miss)
    const results: Array<{ tool: DeferredToolInfo; score: number }> = [];
    for (let i = 0; i < this.catalog.length; i++) {
      const bm25Norm = bm25Scores[i]! / bm25Div;
      const regexNorm = regexScores[i]! / regexDiv;
      const combined = bm25Norm + regexNorm;
      if (combined <= 0) continue;

      // Required token filter — all must appear in searchable text
      if (required.length > 0) {
        const tool = this.catalog[i]!;
        const searchText = `${tool.name.toLowerCase()} ${tool.description.toLowerCase()} ${tool.serverName.toLowerCase()}`;
        if (!required.every((r) => searchText.includes(r))) continue;
      }

      results.push({ tool: this.catalog[i]!, score: combined });
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
function summarizeSchemaArgs(schema: Record<string, unknown>): string {
  const props = schema['properties'];
  if (!props || typeof props !== 'object' || Array.isArray(props)) return 'no args';

  const requiredRaw = schema['required'];
  const required = new Set(Array.isArray(requiredRaw) ? requiredRaw.filter((v): v is string => typeof v === 'string') : []);
  const names = Object.keys(props as Record<string, unknown>);
  if (names.length === 0) return 'no args';

  const shown = names.slice(0, 12).map((name) => required.has(name) ? `${name}*` : name);
  const suffix = names.length > shown.length ? `, +${names.length - shown.length} more` : '';
  return shown.join(', ') + suffix;
}

function compactDescription(description: string): string {
  const normalized = description.replace(/\s+/g, ' ').trim();
  if (normalized.length <= 260) return normalized;
  return `${normalized.slice(0, 257).trimEnd()}...`;
}

/**
 * Render a discovered tool with its FULL input JSON Schema inline — the way
 * Codex returns ToolSearch results for the OpenAI Responses API.
 *
 * Claude Code can get away with name-only `tool_reference` blocks because the
 * Anthropic API server expands them server-side into `<functions>` schema
 * blocks. We talk to plain OpenAI-compatible vLLM/Cortex endpoints where no
 * such expansion exists, so weaker open models (e.g. GLM-4.7) that only see a
 * terse arg summary fail to connect "tool name" with "callable tool" and fall
 * back to faking the call via `bash echo "<toolname>"`. Putting the concrete
 * schema in the result, at discovery time, is what lets them emit the real call.
 */
function formatToolWithSchema(t: DeferredToolInfo): string {
  const schema = JSON.stringify(t.inputSchema ?? { type: 'object', properties: {} }, null, 2);
  return [
    `### ${t.name}`,
    `Server: ${t.serverName}`,
    compactDescription(t.description),
    '',
    'Input JSON Schema:',
    '```json',
    schema,
    '```',
  ].join('\n');
}

/**
 * Models served over plain OpenAI-compatible endpoints (our self-hosted
 * open-weight stack) have no server-side `tool_reference` expansion, so they
 * need the full schema inlined in the ToolSearch result. Hosted frontier
 * providers (Anthropic/OpenAI/Google) handle the terse summary fine and we keep
 * their transcript lean.
 */
export function modelNeedsInlineToolSchemas(model: string): boolean {
  const m = (model ?? '').toLowerCase();
  return (
    isCortexModelId(m) ||
    m.startsWith('vllm/') ||
    m.startsWith('ollama/') ||
    m.startsWith('llamacpp/')
  );
}

/**
 * Self-hosted OpenAI-compatible runtimes have no native `tool_reference`
 * expansion. Their tool parsers can nevertheless emit a structured call for a
 * tool whose full schema was supplied in conversation history (verified for
 * DeepSeek V4 Flash through Cortex). Keeping discovered schemas out of the
 * top-level tools array makes every request a literal history extension and
 * preserves the vLLM KV prefix.
 *
 * Hosted APIs remain on the compatibility path: discovered schemas are added
 * to the declared tools array because those APIs constrain calls to declared
 * functions.
 */
export function modelSupportsAppendOnlyToolActivation(model: string): boolean {
  const normalized = (model ?? '')
    .toLowerCase()
    .replace(/^(?:cortex|vllm|ollama|llamacpp)\//, '');
  // Keep this allow-list evidence-based. DeepSeek V4 Flash has an 8/8 live
  // parser bench for history-only schemas; other self-hosted models still get
  // the full schema in history but retain declared-schema compatibility until
  // they pass the same gate.
  return /^deepseek[-_/ .]?v4[-_/ .]?flash(?:$|[-_/ .])/.test(normalized);
}

/**
 * Build the provider-visible tool surface for deferred MCP discovery.
 *
 * Non-MCP definitions are a stable head. Hosted-provider compatibility schemas
 * are appended in first-discovery order; self-hosted append-only mode keeps the
 * head byte-identical and relies on the schema embedded in ToolSearch history.
 */
export function buildDeferredToolDefinitions(
  allDefinitions: ToolDefinition[],
  state: ToolSearchState,
  appendOnlyActivation: boolean,
): ToolDefinition[] {
  const stableHead = allDefinitions.filter((definition) => !definition.name.startsWith('mcp__'));
  if (appendOnlyActivation) return stableHead;

  const byName = new Map(allDefinitions.map((definition) => [definition.name, definition]));
  const discovered = state.getDiscoveredInOrder()
    .map((name) => byName.get(name))
    .filter((definition): definition is ToolDefinition => definition !== undefined);
  return [...stableHead, ...discovered];
}

function normalizeSelector(value: string): string {
  return value
    .trim()
    .replace(/^[`"']+|[`"']+$/g, '')
    .toLowerCase()
    .replace(/[.\s/]+/g, '_');
}

function toolSelectorAliases(tool: DeferredToolInfo): string[] {
  const full = normalizeSelector(tool.name);
  const short = full.replace(/^mcp__[^_]+__/, '');
  const server = normalizeSelector(tool.serverName);
  const serverShort = server.startsWith('shizuha-') ? server.slice('shizuha-'.length) : server;
  return [
    full,
    short,
    `${server}__${short}`,
    `${serverShort}__${short}`,
    `${server}:${short}`,
    `${serverShort}:${short}`,
  ];
}

export function createToolSearchTool(
  state: ToolSearchState,
  maxResultsCap = 3,
  opts?: { inlineSchemas?: boolean | (() => boolean) },
): ToolHandler {
  const resolveInline = (): boolean =>
    typeof opts?.inlineSchemas === 'function' ? opts.inlineSchemas() : (opts?.inlineSchemas ?? false);
  const sourceSummary = state.getServers()
    .map((server) => `${server.name}: ${server.description || server.name}`)
    .join('; ');
  return {
    name: 'ToolSearch',
    description:
      'Search for or select deferred tools to make them available for use. ' +
      'Use keywords to search (e.g., "inventory list items") or "select:tool_name" for direct selection. ' +
      'Prefix with + to require a match (e.g., "+pulse create task"). ' +
      'Found tools become available on your next action.' +
      (sourceSummary ? ` Available sources: ${sourceSummary}.` : ''),
    parameters: z.object({
      query: z.string().describe(
        'Search keywords or "select:tool_name" for direct selection. Use + prefix to require a term.',
      ),
      max_results: z.number().int().min(1).max(10).default(maxResultsCap).describe(
        `Maximum number of results to return (default/cap: ${maxResultsCap})`,
      ),
    }),
    readOnly: true,
    riskLevel: 'low',

    async execute(params: unknown, _context: ToolContext): Promise<ToolResult> {
      const { query, max_results } = params as { query: string; max_results?: number };
      const limit = Math.min(max_results ?? maxResultsCap, maxResultsCap);
      const results = state.search(query, limit);

      if (results.length === 0) {
        const servers = state.getServers();
        const serverList = servers.map((s) => `${s.name} (${s.description || s.name})`).join(', ');
        return {
          toolUseId: '',
          content: state.catalogSize === 0
            ? `The deferred tool catalog is still connecting. Available servers: ${serverList || 'none configured'}. Try ToolSearch again on your next action.`
            : `No tools found matching "${query}". Available servers: ${serverList}. Try different keywords.`,
        };
      }

      // Mark as discovered — they'll be in the tools array next turn
      state.markDiscovered(results.map((t) => t.name));

      // Inline-schema mode (Codex-style): emit the full input JSON Schema for
      // each match so open models served over plain OpenAI-compatible endpoints
      // (no server-side tool_reference expansion) actually emit the real call
      // instead of faking it via bash. The tool is ALSO added to the next turn's
      // tools array (getToolDefs filters on discovered) — schema-in-result is the
      // attention signal, tools-array membership is what makes it callable.
      if (resolveInline()) {
        const detailed = results.map(formatToolWithSchema).join('\n\n');
        return {
          toolUseId: '',
          content:
            `Found ${results.length} tool(s). They are now available — call one DIRECTLY by its exact name (shown below) on your next action. ` +
            `Do NOT echo the tool name through bash or any other tool, and do not call ToolSearch again unless none of these fit.\n\n${detailed}`,
        };
      }

      // Compact summary (hosted frontier models): names + args only. The full
      // schemas reach the model via the provider's tools array on the next turn.
      const summary = results
        .map((t) => `- **${t.name}** (${t.serverName}) args: ${summarizeSchemaArgs(t.inputSchema)}\n  ${compactDescription(t.description)}`)
        .join('\n');

      return {
        toolUseId: '',
        content:
          `Found ${results.length} tool(s). Call one of these discovered tools directly on your next action; do not call ToolSearch again unless none fit.\n` +
          `Required args are marked with *.\n\n${summary}`,
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

/**
 * Stable server awareness derived from configuration, not connection results.
 * Connection instructions/counts can change between requests (or race TUI
 * startup), so they must not be woven into the cached system/tool prefix.
 */
export function buildConfiguredServerSummaries(
  configs: Array<{ name: string }>,
): MCPServerSummary[] {
  const unique = new Set(configs.map((config) => config.name));
  return [...unique]
    .sort((a, b) => a.localeCompare(b))
    .map((name) => {
      const normalizedName = name.startsWith('shizuha-') ? name.slice(8) : name;
      return {
        name,
        description: KNOWN_DESCRIPTIONS[normalizedName] ?? name,
        // Deliberately excluded from prompt rendering. Live counts vary with
        // connection timing and are search telemetry, not model guidance.
        toolCount: 0,
      };
    });
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
      .map((s) => `- **${s.name}**: ${s.description || s.name}${s.toolCount > 0 ? ` (${s.toolCount} tools)` : ''}`)
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
