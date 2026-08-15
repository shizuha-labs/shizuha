import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({
  name: 'ci_mock',
  version: '1.0.0',
});

server.tool(
  'ci_echo',
  'Echo text for Shizuha CI MCP validation.',
  { text: z.string() },
  async ({ text }) => ({
    content: [{ type: 'text', text: `ci_echo:${text}` }],
  }),
);

server.tool(
  'ci_add',
  'Add two numbers for Shizuha CI MCP validation.',
  { a: z.number(), b: z.number() },
  async ({ a, b }) => ({
    content: [{ type: 'text', text: String(a + b) }],
  }),
);

await server.connect(new StdioServerTransport());
