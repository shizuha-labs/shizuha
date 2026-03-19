import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { WebSocketClientTransport } from '@modelcontextprotocol/sdk/client/websocket.js';
import type { ServerCapabilities } from '@modelcontextprotocol/sdk/types.js';
import type { MCPServerConfig } from '../../agent/types.js';
import type { ImageData } from '../types.js';
import { logger } from '../../utils/logger.js';

// ── Types ──

export interface MCPToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface MCPToolInfo {
  /** Prefixed name: mcp__<server>__<tool> */
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: MCPToolAnnotations;
}

export interface MCPResourceInfo {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface MCPToolResult {
  content: string;
  isError?: boolean;
  image?: ImageData;
}

export interface MCPConnection {
  client: Client;
  config: MCPServerConfig;
  transport: StdioClientTransport | SSEClientTransport | StreamableHTTPClientTransport | WebSocketClientTransport;
  capabilities?: ServerCapabilities;
  serverVersion?: { name: string; version: string };
  instructions?: string;
  tools: MCPToolInfo[];
  resources: MCPResourceInfo[];
}

// ── Constants ──

const DEFAULT_TOOL_TIMEOUT_MS = 120_000;
const DEFAULT_RESOURCE_TIMEOUT_MS = 30_000;
/** Max MCP output in estimated tokens */
const MAX_MCP_OUTPUT_TOKENS = 25_000;

// ── Connection ──

export interface ConnectMCPOptions {
  /** Callback when the server notifies that its tool list has changed */
  onToolsChanged?: () => void;
}

/** Connect to an MCP server via stdio, Streamable HTTP, or WebSocket */
export async function connectMCP(
  config: MCPServerConfig,
  options?: ConnectMCPOptions,
): Promise<MCPConnection> {
  const clientOptions: ConstructorParameters<typeof Client>[1] = {
    capabilities: {},
  };

  // Wire listChanged handler if callback provided
  if (options?.onToolsChanged) {
    const cb = options.onToolsChanged;
    clientOptions.listChanged = {
      tools: {
        onChanged: (error) => {
          if (error) {
            logger.warn({ server: config.name, err: error }, 'MCP listChanged error');
            return;
          }
          cb();
        },
      },
    };
  }

  const client = new Client(
    { name: 'shizuha', version: '0.1.0' },
    clientOptions,
  );

  let transport: StdioClientTransport | SSEClientTransport | StreamableHTTPClientTransport | WebSocketClientTransport;

  if (config.transport === 'stdio') {
    if (!config.command) throw new Error(`MCP server "${config.name}": stdio transport requires command`);
    transport = new StdioClientTransport({
      command: config.command,
      args: config.args ?? [],
      env: { ...process.env, ...config.env } as Record<string, string>,
    });
  } else if (config.transport === 'sse') {
    if (!config.url) throw new Error(`MCP server "${config.name}": sse transport requires url`);
    const sseOpts: ConstructorParameters<typeof SSEClientTransport>[1] = {};
    if (config.headers && Object.keys(config.headers).length > 0) {
      sseOpts.eventSourceInit = { fetch: (url: string | URL, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        for (const [k, v] of Object.entries(config.headers!)) headers.set(k, v);
        return fetch(url, { ...init, headers });
      }};
      sseOpts.requestInit = { headers: { ...config.headers } };
    }
    transport = new SSEClientTransport(new URL(config.url), sseOpts);
  } else if (config.transport === 'streamable-http') {
    if (!config.url) throw new Error(`MCP server "${config.name}": streamable-http transport requires url`);
    const opts: ConstructorParameters<typeof StreamableHTTPClientTransport>[1] = {};
    // Custom headers (e.g., Authorization)
    if (config.headers && Object.keys(config.headers).length > 0) {
      opts.requestInit = { headers: { ...config.headers } };
    }
    // Reconnection options
    if (config.reconnection) {
      opts.reconnectionOptions = {
        maxReconnectionDelay: config.reconnection.maxReconnectionDelay ?? 30000,
        initialReconnectionDelay: config.reconnection.initialReconnectionDelay ?? 1000,
        reconnectionDelayGrowFactor: config.reconnection.reconnectionDelayGrowFactor ?? 1.5,
        maxRetries: config.reconnection.maxRetries ?? 2,
      };
    }
    transport = new StreamableHTTPClientTransport(new URL(config.url), opts);
  } else if (config.transport === 'websocket') {
    if (!config.url) throw new Error(`MCP server "${config.name}": websocket transport requires url`);
    transport = new WebSocketClientTransport(new URL(config.url));
  } else {
    throw new Error(`MCP server "${config.name}": unknown transport "${config.transport}"`);
  }

  await client.connect(transport);

  // Read server metadata
  const capabilities = client.getServerCapabilities();
  const sv = client.getServerVersion();
  const serverVersion = sv ? { name: sv.name, version: sv.version } : undefined;
  const instructions = client.getInstructions();

  // List tools if supported
  let tools: MCPToolInfo[] = [];
  if (capabilities?.tools) {
    tools = await listMCPToolsInternal(client, config.name);
  }

  // List resources if supported
  let resources: MCPResourceInfo[] = [];
  if (capabilities?.resources) {
    try {
      const result = await client.listResources();
      resources = (result.resources ?? []).map((r) => ({
        uri: r.uri,
        name: r.name,
        description: r.description,
        mimeType: r.mimeType,
      }));
    } catch (err) {
      logger.warn({ server: config.name, err }, 'Failed to list MCP resources');
    }
  }

  logger.info(
    { server: config.name, transport: config.transport, tools: tools.length, resources: resources.length },
    'MCP connected',
  );

  return { client, config, transport, capabilities, serverVersion, instructions, tools, resources };
}

// ── Tool Listing ──

/** Internal: list tools from a Client instance */
async function listMCPToolsInternal(client: Client, serverName: string): Promise<MCPToolInfo[]> {
  const result = await client.listTools();
  return (result.tools ?? []).map((t) => ({
    name: `mcp__${serverName}__${t.name}`,
    description: t.description ?? '',
    inputSchema: (t.inputSchema ?? {}) as Record<string, unknown>,
    annotations: t.annotations ? {
      title: t.annotations.title,
      readOnlyHint: t.annotations.readOnlyHint,
      destructiveHint: t.annotations.destructiveHint,
      idempotentHint: t.annotations.idempotentHint,
      openWorldHint: t.annotations.openWorldHint,
    } : undefined,
  }));
}

/** List tools from an MCP connection (returns cached list) */
export function listMCPTools(conn: MCPConnection): MCPToolInfo[] {
  return conn.tools;
}

/** Refresh tools from server (re-fetches from server) */
export async function refreshMCPTools(conn: MCPConnection): Promise<MCPToolInfo[]> {
  conn.tools = await listMCPToolsInternal(conn.client, conn.config.name);
  return conn.tools;
}

// ── Tool Execution ──

/** Resolve the effective timeout for an MCP tool call */
function resolveToolTimeout(config: MCPServerConfig): number {
  if (config.toolTimeoutMs) return config.toolTimeoutMs;
  const envTimeout = process.env['MCP_TOOL_TIMEOUT'];
  if (envTimeout) {
    const parsed = parseInt(envTimeout, 10);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_TOOL_TIMEOUT_MS;
}

/** Combine an optional abort signal with a timeout into a single signal */
function combinedSignal(timeoutMs: number, abortSignal?: AbortSignal): AbortSignal {
  const timeoutSig = AbortSignal.timeout(timeoutMs);
  if (!abortSignal) return timeoutSig;
  return AbortSignal.any([abortSignal, timeoutSig]);
}

/** Call an MCP tool with timeout, abort signal, and rich content handling */
export async function callMCPTool(
  conn: MCPConnection,
  toolName: string,
  args: Record<string, unknown>,
  abortSignal?: AbortSignal,
): Promise<MCPToolResult> {
  // Strip the mcp__<server>__ prefix to get the real tool name
  const prefix = `mcp__${conn.config.name}__`;
  const realName = toolName.startsWith(prefix) ? toolName.slice(prefix.length) : toolName;

  const timeoutMs = resolveToolTimeout(conn.config);
  const signal = combinedSignal(timeoutMs, abortSignal);

  const result = await conn.client.callTool(
    { name: realName, arguments: args },
    undefined,
    { signal },
  );

  const content = result.content as Array<Record<string, unknown>>;
  const isError = 'isError' in result ? (result.isError as boolean | undefined) : undefined;
  return processToolOutput(content, isError);
}

// ── Rich Content Processing ──

/** Process MCP tool output — handles text, image, audio, resource, resource_link content types */
export function processToolOutput(
  content: Array<Record<string, unknown>>,
  isError?: boolean,
): MCPToolResult {
  const textParts: string[] = [];
  let firstImage: ImageData | undefined;

  for (const item of content) {
    const type = item['type'] as string;

    switch (type) {
      case 'text':
        textParts.push(item['text'] as string ?? '');
        break;

      case 'image': {
        const data = item['data'] as string;
        const mimeType = item['mimeType'] as string;
        const supported = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
        if (data && mimeType && supported.includes(mimeType as typeof supported[number]) && !firstImage) {
          firstImage = { base64: data, mediaType: mimeType as ImageData['mediaType'] };
        } else {
          textParts.push(`[Image: ${mimeType ?? 'unknown type'}]`);
        }
        break;
      }

      case 'audio': {
        const mimeType = item['mimeType'] as string;
        textParts.push(`[Audio: ${mimeType ?? 'unknown type'}]`);
        break;
      }

      case 'resource': {
        const resource = item['resource'] as Record<string, unknown> | undefined;
        if (resource) {
          if (typeof resource['text'] === 'string') {
            textParts.push(resource['text']);
          } else if (typeof resource['blob'] === 'string') {
            const uri = resource['uri'] as string ?? 'unknown';
            textParts.push(`[Binary resource: ${uri}]`);
          }
        }
        break;
      }

      case 'resource_link': {
        const uri = item['uri'] as string;
        const name = item['name'] as string;
        textParts.push(`[Resource: ${name ?? 'unnamed'} (${uri ?? 'no URI'})]`);
        break;
      }

      default:
        // Unknown content type — include as text if possible
        if (typeof item['text'] === 'string') {
          textParts.push(item['text']);
        }
        break;
    }
  }

  let text = textParts.join('\n');

  // Output truncation: estimate tokens as text.length / 4, truncate at MAX_MCP_OUTPUT_TOKENS
  const estimatedTokens = Math.ceil(text.length / 4);
  if (estimatedTokens > MAX_MCP_OUTPUT_TOKENS) {
    const maxChars = MAX_MCP_OUTPUT_TOKENS * 4;
    text = text.slice(0, maxChars) +
      `\n\n[Output truncated: ~${estimatedTokens} tokens exceeded ${MAX_MCP_OUTPUT_TOKENS} token limit]`;
  }

  return { content: text, isError: isError ?? false, image: firstImage };
}

// ── Resource Reading ──

/** Read a resource from an MCP server */
export async function readMCPResource(
  conn: MCPConnection,
  uri: string,
  abortSignal?: AbortSignal,
): Promise<string> {
  if (!conn.capabilities?.resources) {
    throw new Error(`MCP server "${conn.config.name}" does not support resources`);
  }

  const signal = combinedSignal(DEFAULT_RESOURCE_TIMEOUT_MS, abortSignal);

  const result = await conn.client.readResource(
    { uri },
    { signal },
  );

  const parts: string[] = [];
  for (const item of result.contents) {
    if ('text' in item && typeof item.text === 'string') {
      parts.push(item.text);
    } else if ('blob' in item && typeof item.blob === 'string') {
      parts.push(`[Binary blob: ${item.uri}]`);
    }
  }
  return parts.join('\n');
}

// ── Disconnect ──

/** Disconnect from an MCP server */
export async function disconnectMCP(conn: MCPConnection): Promise<void> {
  try {
    await conn.client.close();
    logger.info({ server: conn.config.name }, 'MCP disconnected');
  } catch (err) {
    logger.warn({ server: conn.config.name, err }, 'MCP disconnect error');
  }
}
