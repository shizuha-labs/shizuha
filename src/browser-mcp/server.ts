#!/usr/bin/env node
/**
 * Browser MCP stdio server (PLAT-5106)
 *
 * Exposes the native SCLI browser/mouse/keyboard tools over a local stdio MCP
 * surface so Claude/Codex/Gemini bridge agents (which do not load the gateway
 * ToolRegistry) can call them after cron-mcp was decommissioned.
 *
 * Design mirrors mcp-proxy / mcp-multiplexer: hand-rolled line-delimited
 * JSON-RPC on stdin/stdout. No upstream HTTP — tools execute in-process via
 * the same handlers registered for the gateway path.
 *
 * Tools advertised:
 *   - browser  (navigate/screenshot/click/type/scroll/get_text/evaluate/back/close)
 *   - mouse    (human-mode coordinate input)
 *   - keyboard (human-mode typed input)
 *
 * Session identity is fixed for the process lifetime so successive tool calls
 * share one Playwright session (same contract as the native gateway tools).
 */

import * as readline from 'node:readline';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ToolHandler, ToolContext, ToolResult } from '../tools/types.js';
import { browserTool } from '../tools/builtin/browser.js';
import { mouseTool } from '../tools/builtin/mouse.js';
import { keyboardTool } from '../tools/builtin/keyboard.js';

const DEFAULT_PROTOCOL_VERSION = '2025-06-18';
const SERVER_INFO = { name: 'shizuha-browser-mcp', version: '1.0.0' };

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

export interface BrowserMcpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** Tools exposed by this MCP server — exported for unit tests. */
export const BROWSER_MCP_TOOLS: ToolHandler[] = [browserTool, mouseTool, keyboardTool];

function log(msg: string): void {
  // Never write to stdout — that is the JSON-RPC channel.
  process.stderr.write(`[browser-mcp] ${msg}\n`);
}

function writeStdout(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function sendResult(id: string | number, result: unknown): void {
  writeStdout({ jsonrpc: '2.0', id, result });
}

function sendError(id: string | number, code: number, message: string, data?: unknown): void {
  writeStdout({
    jsonrpc: '2.0',
    id,
    error: { code, message, ...(data !== undefined ? { data } : {}) },
  });
}

/** Convert a native ToolHandler into an MCP tools/list entry. */
export function toMcpToolDef(tool: ToolHandler): BrowserMcpToolDef {
  const raw = (tool.inputSchema
    ?? zodToJsonSchema(tool.parameters, { target: 'openApi3', $refStrategy: 'none' })) as Record<string, unknown>;
  // Strip JSON-Schema meta keys MCP clients do not need.
  const { $schema, definitions, $defs, ...rest } = raw;
  void $schema;
  void definitions;
  void $defs;
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: rest,
  };
}

/** List the MCP tool surface (name/description/schema). Exported for tests. */
export function listBrowserMcpTools(tools: ToolHandler[] = BROWSER_MCP_TOOLS): BrowserMcpToolDef[] {
  return tools.map(toMcpToolDef);
}

function resolveToolContext(): ToolContext {
  const sessionId = (process.env['BROWSER_MCP_SESSION_ID'] || 'browser-mcp').trim() || 'browser-mcp';
  const cwd = (process.env['BROWSER_MCP_CWD'] || process.env['PWD'] || process.cwd()).trim() || process.cwd();
  return { cwd, sessionId };
}

type McpContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

/** Map a native ToolResult onto the MCP tools/call response shape. */
export function toolResultToMcp(result: ToolResult): {
  content: McpContentPart[];
  isError?: boolean;
} {
  const content: McpContentPart[] = [];
  if (result.content) {
    content.push({ type: 'text', text: result.content });
  }
  if (result.image?.base64) {
    content.push({
      type: 'image',
      data: result.image.base64,
      mimeType: result.image.mediaType || 'image/png',
    });
  }
  if (content.length === 0) {
    content.push({ type: 'text', text: result.isError ? 'Tool failed with no message.' : 'OK' });
  }
  return {
    content,
    ...(result.isError ? { isError: true } : {}),
  };
}

async function callTool(
  name: string,
  args: unknown,
  tools: ToolHandler[] = BROWSER_MCP_TOOLS,
  context: ToolContext = resolveToolContext(),
): Promise<ReturnType<typeof toolResultToMcp>> {
  const tool = tools.find((t) => t.name === name);
  if (!tool) {
    return {
      content: [{ type: 'text', text: `Unknown tool: ${name}` }],
      isError: true,
    };
  }
  try {
    const result = await tool.execute(args ?? {}, context);
    return toolResultToMcp(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: 'text', text: `browser-mcp tool error (${name}): ${message}` }],
      isError: true,
    };
  }
}

async function handleRequest(msg: JsonRpcMessage): Promise<void> {
  const id = msg.id as string | number;
  const method = msg.method!;
  const params = (msg.params ?? {}) as Record<string, unknown>;

  if (method === 'initialize') {
    const clientProtocol = typeof params.protocolVersion === 'string'
      ? params.protocolVersion
      : undefined;
    sendResult(id, {
      protocolVersion: clientProtocol || DEFAULT_PROTOCOL_VERSION,
      capabilities: {
        tools: { listChanged: false },
      },
      serverInfo: SERVER_INFO,
      instructions:
        'Local browser automation MCP. Tools: browser, mouse, keyboard. ' +
        'Start with browser(action="navigate", url=...) then screenshot/interact. ' +
        'Human-mode mouse/keyboard require browser mode="human".',
    });
    return;
  }

  if (method === 'ping') {
    sendResult(id, {});
    return;
  }

  if (method === 'tools/list') {
    sendResult(id, { tools: listBrowserMcpTools() });
    return;
  }

  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = params.arguments;
    if (!name) {
      sendError(id, -32602, 'tools/call requires params.name');
      return;
    }
    const result = await callTool(name, args);
    sendResult(id, result);
    return;
  }

  // Resources / prompts are not offered.
  if (method === 'resources/list') {
    sendResult(id, { resources: [] });
    return;
  }
  if (method === 'prompts/list') {
    sendResult(id, { prompts: [] });
    return;
  }

  sendError(id, -32601, `Method not found: ${method}`);
}

async function handleNotification(msg: JsonRpcMessage): Promise<void> {
  // Handshake notification — nothing to do.
  if (msg.method === 'notifications/initialized') return;
  // Ignore other client→server notifications.
}

/**
 * Run the browser MCP stdio server until stdin closes.
 * Exported so tests can import helpers without starting the loop.
 */
export async function runBrowserMcpServer(): Promise<void> {
  log(`starting stdio browser MCP (tools: ${BROWSER_MCP_TOOLS.map((t) => t.name).join(', ')})`);

  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(trimmed) as JsonRpcMessage;
    } catch {
      return;
    }
    if (!msg.method) return;
    if (msg.id !== undefined && msg.id !== null) {
      void handleRequest(msg).catch((err) => {
        log(`unhandled request error (${msg.method}): ${(err as Error).message}`);
        if (msg.id !== undefined && msg.id !== null) {
          sendError(msg.id as string | number, -32603, (err as Error).message ?? 'internal error');
        }
      });
    } else {
      void handleNotification(msg);
    }
  });

  rl.on('close', () => {
    log('stdin closed — exiting');
    process.exit(0);
  });

  process.on('unhandledRejection', (reason) => {
    log(`unhandledRejection (kept alive): ${reason instanceof Error ? reason.message : String(reason)}`);
  });
  process.on('uncaughtException', (err) => {
    log(`uncaughtException (kept alive): ${err.message}`);
  });
}
