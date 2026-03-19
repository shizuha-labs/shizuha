import { z } from 'zod';
import type { ToolHandler, ToolContext, ToolResult } from '../types.js';

export const webSearchTool: ToolHandler = {
  name: 'web_search',
  description:
    'Search the web using a search engine. Returns search results with titles, URLs, and snippets.',
  parameters: z.object({
    query: z.string().describe('Search query'),
    max_results: z.number().int().min(1).max(20).optional().default(5),
  }),
  readOnly: true,
  riskLevel: 'low',

  async execute(params: unknown, _context: ToolContext): Promise<ToolResult> {
    const { query, max_results } = this.parameters.parse(params);

    // Try Brave Search API first, then SearXNG
    const braveKey = process.env['BRAVE_SEARCH_API_KEY'];
    if (braveKey) {
      return searchBrave(query, max_results, braveKey);
    }

    const searxngUrl = process.env['SEARXNG_URL'];
    if (searxngUrl) {
      return searchSearXNG(query, max_results, searxngUrl);
    }

    return {
      toolUseId: '',
      content: 'No search backend configured. Set BRAVE_SEARCH_API_KEY or SEARXNG_URL.',
      isError: true,
    };
  },
};

async function searchBrave(query: string, maxResults: number, apiKey: string): Promise<ToolResult> {
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

async function searchSearXNG(query: string, maxResults: number, baseUrl: string): Promise<ToolResult> {
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
