import { z } from 'zod';
import type { ToolHandler, ToolContext, ToolResult } from '../types.js';

const MAX_BODY = 200 * 1024; // 200KB

export const webFetchTool: ToolHandler = {
  name: 'web_fetch',
  description:
    'Fetch content from a URL. Returns the response body as text (HTML is converted to simplified text). ' +
    'Useful for reading documentation, API responses, etc.',
  parameters: z.object({
    url: z.string().url().describe('URL to fetch'),
    headers: z.record(z.string()).optional().describe('Additional HTTP headers'),
  }),
  readOnly: true,
  riskLevel: 'medium',

  async execute(params: unknown, context: ToolContext): Promise<ToolResult> {
    const { url, headers } = this.parameters.parse(params);

    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Shizuha/0.1',
          ...headers,
        },
        signal: AbortSignal.timeout(30000),
      });

      if (!response.ok) {
        return {
          toolUseId: '',
          content: `HTTP ${response.status}: ${response.statusText}`,
          isError: true,
        };
      }

      let body = await response.text();
      if (body.length > MAX_BODY) {
        body = body.slice(0, MAX_BODY) + '\n[Content truncated]';
      }

      // Simple HTML → text stripping (basic; turndown can be used for richer conversion)
      const contentType = response.headers.get('content-type') ?? '';
      if (contentType.includes('html')) {
        try {
          const TurndownService = (await import('turndown')).default;
          const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
          body = td.turndown(body);
        } catch {
          // Fallback: strip tags
          body = body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        }
      }

      return { toolUseId: '', content: body };
    } catch (err) {
      return { toolUseId: '', content: `Fetch error: ${(err as Error).message}`, isError: true };
    }
  },
};
