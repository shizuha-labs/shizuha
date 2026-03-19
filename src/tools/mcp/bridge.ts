import { z } from 'zod';
import type { ToolHandler, ToolContext, ToolResult } from '../types.js';
import type { MCPManager } from './manager.js';
import type { MCPToolInfo, MCPToolAnnotations } from './client.js';
import { callMCPTool, readMCPResource } from './client.js';

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
    readOnly: deriveReadOnly(toolInfo.annotations),
    riskLevel: deriveRiskLevel(toolInfo.annotations),

    async execute(params: unknown, context: ToolContext): Promise<ToolResult> {
      const conn = manager.getForTool(toolInfo.name);
      if (!conn) {
        return {
          toolUseId: '',
          content: `MCP server not connected for tool "${toolInfo.name}"`,
          isError: true,
        };
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
