import { z } from 'zod';
import type { ToolHandler, ToolContext, ToolResult } from '../types.js';
import type { MCPManager } from './manager.js';
import type { MCPToolInfo, MCPToolAnnotations } from './client.js';
import { callMCPTool, readMCPResource } from './client.js';
import { logger } from '../../utils/logger.js';

// ── Annotation → readOnly / riskLevel mapping ──

/** Derive readOnly from MCP tool annotations */
export function deriveReadOnly(annotations?: MCPToolAnnotations): boolean {
  if (!annotations) return false;
  return annotations.readOnlyHint === true;
}

/** Derive risk level from MCP tool annotations */
export function deriveRiskLevel(annotations?: MCPToolAnnotations): 'low' | 'medium' | 'high' {
  if (!annotations) return 'medium';
  // Read-only tools are low risk
  if (annotations.readOnlyHint === true) return 'low';
  // Destructive write tools are high risk (destructiveHint defaults to true when absent)
  if (annotations.destructiveHint !== false) return 'high';
  // Non-destructive write tools are medium risk
  return 'medium';
}

// ── Error classification ──

/** Classify MCP errors for user-facing messages */
function classifyError(err: unknown): { message: string; isTimeout: boolean } {
  const raw = (err as Error)?.message ?? String(err);
  const name = (err as Error)?.name ?? '';

  // Timeout (AbortSignal.timeout or AbortError from timeout)
  if (name === 'TimeoutError' || /timed?\s*out/i.test(raw) ||
      (name === 'AbortError' && /timeout/i.test(raw))) {
    return { message: `MCP tool timed out: ${raw}`, isTimeout: true };
  }

  // Connection errors
  if (/ECONNREFUSED|ECONNRESET|EPIPE|ENOTFOUND/i.test(raw) ||
      /connection.*closed|transport.*closed/i.test(raw)) {
    return { message: `MCP connection error: ${raw}`, isTimeout: false };
  }

  return { message: `MCP tool error: ${raw}`, isTimeout: false };
}

function shouldReconnectAfterToolError(err: unknown): boolean {
  const raw = (err as Error)?.message ?? String(err);
  return /Session not found/i.test(raw)
    || /Streamable HTTP error/i.test(raw)
    || /connection.*closed/i.test(raw)
    || /transport.*closed/i.test(raw)
    || /ECONNREFUSED|ECONNRESET|EPIPE|ENOTFOUND|fetch failed/i.test(raw);
}

function normalizeMCPInputSchema(schema: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!schema || Object.keys(schema).length === 0) {
    return { type: 'object', properties: {} };
  }
  if (schema['type'] === 'object') return schema;
  return { type: 'object', properties: {}, ...schema };
}

// ── Tool Handler Creation ──

/** Create a ToolHandler that bridges to an MCP tool */
export function createMCPToolHandler(
  toolInfo: MCPToolInfo,
  manager: MCPManager,
): ToolHandler {
  return {
    name: toolInfo.name,
    description: toolInfo.description,
    // Validate input is at least an object (not z.any() which allows anything)
    parameters: z.object({}).passthrough(),
    inputSchema: normalizeMCPInputSchema(toolInfo.inputSchema),
    readOnly: deriveReadOnly(toolInfo.annotations),
    riskLevel: deriveRiskLevel(toolInfo.annotations),

    async execute(params: unknown, context: ToolContext): Promise<ToolResult> {
      let conn = manager.getForTool(toolInfo.name);
      if (!conn) {
        // PLAT-912: per-seat MCP disconnect recovery. The connection is absent either because
        // the server was evicted, or because healthReconnectServer is mid-redial (it removes the
        // old connection while establishing the new one). Emit structured telemetry so per-seat
        // disconnections are visible in logs, then attempt recovery before surfacing the error.
        const serverName = toolInfo.name.split('__')[1] ?? '';
        logger.warn(
          { server: serverName, tool: toolInfo.name, event: 'mcp_seat_disconnected' },
          'MCP per-seat disconnect — attempting recovery before surfacing error (PLAT-912)',
        );
        const recovered = await manager.ensureConnected(serverName);
        if (!recovered) {
          return {
            toolUseId: '',
            content: `MCP server not connected for tool "${toolInfo.name}"`,
            isError: true,
          };
        }
        conn = recovered;
      }

      try {
        const result = await callMCPTool(
          conn,
          toolInfo.name,
          (params ?? {}) as Record<string, unknown>,
          context.abortSignal,
        );
        return {
          toolUseId: '',
          content: result.content,
          isError: result.isError,
          image: result.image,
        };
      } catch (err) {
        if (shouldReconnectAfterToolError(err)) {
          const reconnected = await manager.reconnectForTool(toolInfo.name);
          if (reconnected) {
            try {
              const result = await callMCPTool(
                reconnected,
                toolInfo.name,
                (params ?? {}) as Record<string, unknown>,
                context.abortSignal,
              );
              return {
                toolUseId: '',
                content: result.content,
                isError: result.isError,
                image: result.image,
              };
            } catch (retryErr) {
              const { message } = classifyError(retryErr);
              return { toolUseId: '', content: message, isError: true };
            }
          }
        }
        const { message } = classifyError(err);
        return { toolUseId: '', content: message, isError: true };
      }
    },
  };
}

/** Create a synthetic read_resource tool for an MCP server with resource support */
export function createMCPResourceReadTool(
  serverName: string,
  manager: MCPManager,
): ToolHandler {
  const toolName = `mcp__${serverName}__read_resource`;
  return {
    name: toolName,
    description: `Read a resource from the "${serverName}" MCP server by URI`,
    parameters: z.object({
      uri: z.string().describe('The resource URI to read'),
    }),
    readOnly: true,
    riskLevel: 'low',

    async execute(params: unknown, context: ToolContext): Promise<ToolResult> {
      const conn = manager.get(serverName);
      if (!conn) {
        return {
          toolUseId: '',
          content: `MCP server "${serverName}" not connected`,
          isError: true,
        };
      }

      try {
        const { uri } = params as { uri: string };
        const content = await readMCPResource(conn, uri, context.abortSignal);
        return { toolUseId: '', content };
      } catch (err) {
        const { message } = classifyError(err);
        return { toolUseId: '', content: message, isError: true };
      }
    },
  };
}

// ── Registration ──

/** Register all MCP tools from the manager into a tool registry */
export async function registerMCPTools(
  manager: MCPManager,
  register: (handler: ToolHandler) => void,
): Promise<number> {
  const tools = manager.listAllTools();
  for (const tool of tools) {
    register(createMCPToolHandler(tool, manager));
  }
  return tools.length;
}
