import { z } from 'zod';
import type { ToolHandler, ToolContext, ToolResult } from '../types.js';

/**
 * Web search tool — searches the web via configured backends.
 *
 * Priority order:
 * 1. SEARCH_BASE_URL (Shizuha Search — unified platform, recommended)
 * 2. BRAVE_SEARCH_API_KEY (Brave Search API — paid)
 * 3. SEARXNG_URL (raw SearXNG — legacy fallback)
 */
export const webSearchTool: ToolHandler = {
  name: 'web_search',
  description:
    'Search the web for information. Returns results with titles, URLs, snippets, and source attribution. ' +
    'Supports category hints: "news" for recent events, "docs" for technical documentation.',
  parameters: z.object({
    query: z.string().describe('Search query'),
    max_results: z.number().int().min(1).max(20).optional().default(5),
    category: z
      .enum(['general', 'news', 'docs', 'images'])
      .optional()
      .describe('Optional category hint to improve result relevance'),
  }),
  readOnly: true,
  riskLevel: 'low',

  async execute(params: unknown, _context: ToolContext): Promise<ToolResult> {
    const { query, max_results, category } = this.parameters.parse(params);

    // 1. Shizuha Search (preferred — unified search platform)
    const searchUrl = process.env['SEARCH_BASE_URL'] ?? await discoverShizuhaSearch();
    if (searchUrl) {
      return searchShizuha(query, max_results, searchUrl, category);
    }

    // 2. Brave Search API (paid, direct)
    const braveKey = process.env['BRAVE_SEARCH_API_KEY'];
    if (braveKey) {
      return searchBrave(query, max_results, braveKey);
    }

    // 3. SearXNG (legacy fallback — raw metasearch)
    const searxngUrl = process.env['SEARXNG_URL'];
    if (searxngUrl) {
      return searchSearXNG(query, max_results, searxngUrl);
    }

    return {
      toolUseId: '',
      content:
        'No search backend configured. Set SEARCH_BASE_URL (Shizuha Search), BRAVE_SEARCH_API_KEY, or SEARXNG_URL.',
      isError: true,
    };
  },
};

// ── Shizuha Search discovery ──
//
// Fleet pods receive SEARCH_BASE_URL from the daemon render; a TUI on a
// platform host receives nothing (operator 2026-08-05: search "seems broken
// for use with scli agents"). The service is a NodePort on every cluster node,
// so a host session can find it itself: probe the well-known local endpoints
// once, cache the answer for the process lifetime (including a negative
// answer — an off-platform laptop must not re-probe on every call).
const SEARCH_DISCOVERY_CANDIDATES = [
  'http://localhost:30088',
  'http://shizuha-search.search.svc.cluster.local',
];
let discoveredSearchUrl: string | null | undefined;

async function discoverShizuhaSearch(): Promise<string | null> {
  if (discoveredSearchUrl !== undefined) return discoveredSearchUrl;
  for (const candidate of SEARCH_DISCOVERY_CANDIDATES) {
    try {
      const res = await fetch(new URL('/health', candidate), {
        signal: AbortSignal.timeout(1500),
        headers: { Accept: 'application/json' },
      });
      if (res.ok) {
        const body = (await res.json().catch(() => null)) as { status?: string } | null;
        if (body?.status === 'ok') {
          discoveredSearchUrl = candidate;
          return candidate;
        }
      }
    } catch {
      // Not reachable from this vantage — try the next candidate.
    }
  }
  discoveredSearchUrl = null;
  return null;
}

// ── Shizuha Search ──

interface ShizuhaSearchResult {
  title: string;
  url: string;
  snippet: string;
  source: string;
  source_type: string;
  score: number;
  published_at?: string | null;
}

interface ShizuhaSearchResponse {
  query: string;
  results: ShizuhaSearchResult[];
  total: number;
  meta: {
    category: string;
    backends: string[];
    took_ms: number;
    cache?: string;
  };
}

async function searchShizuha(
  query: string,
  maxResults: number,
  baseUrl: string,
  category?: string,
): Promise<ToolResult> {
  try {
    const url = new URL('/search', baseUrl);
    url.searchParams.set('q', query);
    url.searchParams.set('max_results', String(maxResults));
    if (category) url.searchParams.set('category', category);

    const response = await fetch(url.toString(), {
      signal: AbortSignal.timeout(15000),
      headers: { Accept: 'application/json' },
    });

    if (!response.ok) {
      return {
        toolUseId: '',
        content: `Search error: HTTP ${response.status} from Shizuha Search`,
        isError: true,
      };
    }

    const data = (await response.json()) as ShizuhaSearchResponse;
    const results = data.results ?? [];

    if (results.length === 0) {
      return { toolUseId: '', content: `No results found for "${query}".` };
    }

    // Format results with rich metadata
    const lines: string[] = [];
    lines.push(`**${results.length} results** for "${query}" (${data.meta.category}, ${data.meta.took_ms}ms)\n`);

    for (let i = 0; i < results.length; i++) {
      const r = results[i]!;
      const sourceTag = r.source_type !== 'web' ? ` [${r.source_type}]` : '';
      const dateTag = r.published_at ? ` (${r.published_at.split('T')[0]})` : '';
      lines.push(`${i + 1}. [${r.title}](${r.url})${sourceTag}${dateTag}`);
      if (r.snippet) {
        lines.push(`   ${r.snippet}`);
      }
      lines.push(`   *Source: ${r.source}*`);
      lines.push('');
    }

    return { toolUseId: '', content: lines.join('\n') };
  } catch (err) {
    return {
      toolUseId: '',
      content: `Search error: ${(err as Error).message}`,
      isError: true,
    };
  }
}

// ── Brave Search ──

async function searchBrave(
  query: string,
  maxResults: number,
  apiKey: string,
): Promise<ToolResult> {
  try {
    const url = new URL('https://api.search.brave.com/res/v1/web/search');
    url.searchParams.set('q', query);
    url.searchParams.set('count', String(maxResults));

    const response = await fetch(url.toString(), {
      headers: {
        'X-Subscription-Token': apiKey,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(15000),
    });

    const data = (await response.json()) as {
      web?: { results?: Array<{ title: string; url: string; description: string }> };
    };

    const results = data.web?.results ?? [];
    const formatted = results
      .map((r, i) => `${i + 1}. [${r.title}](${r.url})\n   ${r.description}`)
      .join('\n\n');

    return { toolUseId: '', content: formatted || 'No results found.' };
  } catch (err) {
    return { toolUseId: '', content: `Search error: ${(err as Error).message}`, isError: true };
  }
}

// ── SearXNG (legacy fallback) ──

async function searchSearXNG(
  query: string,
  maxResults: number,
  baseUrl: string,
): Promise<ToolResult> {
  try {
    const url = new URL('/search', baseUrl);
    url.searchParams.set('q', query);
    url.searchParams.set('format', 'json');
    url.searchParams.set('pageno', '1');

    const response = await fetch(url.toString(), { signal: AbortSignal.timeout(15000) });
    const data = (await response.json()) as {
      results?: Array<{ title: string; url: string; content: string }>;
    };

    const results = (data.results ?? []).slice(0, maxResults);
    const formatted = results
      .map((r, i) => `${i + 1}. [${r.title}](${r.url})\n   ${r.content}`)
      .join('\n\n');

    return { toolUseId: '', content: formatted || 'No results found.' };
  } catch (err) {
    return { toolUseId: '', content: `Search error: ${(err as Error).message}`, isError: true };
  }
}
