import type { MCPServerConfig } from '../../agent/types.js';
import type { MCPConnection, MCPToolInfo, MCPResourceInfo } from './client.js';
import type { ToolRegistry } from '../registry.js';
import { connectMCP, disconnectMCP, refreshMCPTools } from './client.js';
import { createMCPToolHandler } from './bridge.js';
import { logger } from '../../utils/logger.js';

/** Per-connection timeout for initial connect (prevents single slow server from blocking all) */
const CONNECT_TIMEOUT_MS = 10_000;

export class MCPManager {
  private connections = new Map<string, MCPConnection>();
  private toolRegistry: ToolRegistry | null = null;
  /** Callback invoked after dynamic tool refresh completes */
  onToolsRefreshed?: () => void;

  /** Wire the tool registry for dynamic listChanged refresh */
  setToolRegistry(registry: ToolRegistry): void {
    this.toolRegistry = registry;
  }

  /** Servers that were configured but failed to connect */
  readonly failedServers: Array<{ name: string; error: string }> = [];

  /** Connect to all configured MCP servers (with per-connection timeout) */
  async connectAll(configs: MCPServerConfig[]): Promise<void> {
    (this.failedServers as Array<{ name: string; error: string }>).length = 0;
    const tasks = configs.map(async (config) => {
      try {
        const connectPromise = connectMCP(config, {
          onToolsChanged: () => this.refreshToolsForServer(config.name),
        });
        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Connection timeout after ${CONNECT_TIMEOUT_MS}ms`)), CONNECT_TIMEOUT_MS),
        );
        const conn = await Promise.race([connectPromise, timeoutPromise]);
        this.connections.set(config.name, conn);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ server: config.name, err }, 'Failed to connect MCP server');
        (this.failedServers as Array<{ name: string; error: string }>).push({ name: config.name, error: msg });
      }
    });
    await Promise.all(tasks);
  }

  /** Get a connection by server name */
  get(name: string): MCPConnection | undefined {
    return this.connections.get(name);
  }

  /** Get connection for a tool name (mcp__<server>__<tool>) */
  getForTool(toolName: string): MCPConnection | undefined {
    if (!toolName.startsWith('mcp__')) return undefined;
    const parts = toolName.split('__');
    const serverName = parts[1];
    return serverName ? this.connections.get(serverName) : undefined;
  }

  /** Expose all connections (for resource tool registration) */
  getAll(): Map<string, MCPConnection> {
    return this.connections;
  }

  /** Check if a server supports resources */
  hasResourceSupport(serverName: string): boolean {
    const conn = this.connections.get(serverName);
    return Boolean(conn?.capabilities?.resources);
  }

  /** List all cached tools across all connections (no server roundtrip) */
  listAllTools(): MCPToolInfo[] {
    const allTools: MCPToolInfo[] = [];
    for (const conn of this.connections.values()) {
      allTools.push(...conn.tools);
    }
    return allTools;
  }

  /** List all resources across all connections */
  listAllResources(): MCPResourceInfo[] {
    const allResources: MCPResourceInfo[] = [];
    for (const conn of this.connections.values()) {
      allResources.push(...conn.resources);
    }
    return allResources;
  }

  /** Handle listChanged notification — refresh tools for a single server */
  private async refreshToolsForServer(serverName: string): Promise<void> {
    const conn = this.connections.get(serverName);
    if (!conn) return;

    try {
      const oldToolNames = new Set(conn.tools.map((t) => t.name));
      const newTools = await refreshMCPTools(conn);
      const newToolNames = new Set(newTools.map((t) => t.name));

      if (!this.toolRegistry) {
        logger.info({ server: serverName, tools: newTools.length }, 'MCP tools refreshed (no registry wired)');
        return;
      }

      // Unregister removed tools
      let removed = 0;
      for (const oldName of oldToolNames) {
        if (!newToolNames.has(oldName)) {
          this.toolRegistry.unregister(oldName);
          removed++;
        }
      }

      // Upsert new/changed tools
      let added = 0;
      for (const tool of newTools) {
        if (!oldToolNames.has(tool.name)) {
          added++;
        }
        // Always upsert — schema may have changed even if name didn't
        this.toolRegistry.upsert(createMCPToolHandler(tool, this));
      }

      logger.info({ server: serverName, added, removed, total: newTools.length }, 'MCP tools refreshed');
      this.onToolsRefreshed?.();
    } catch (err) {
      logger.warn({ server: serverName, err }, 'Failed to refresh MCP tools');
    }
  }

  /** Disconnect all */
  async disconnectAll(): Promise<void> {
    const tasks = [...this.connections.values()].map((conn) => disconnectMCP(conn));
    await Promise.all(tasks);
    this.connections.clear();
  }

  /** Number of active connections */
  get size(): number {
    return this.connections.size;
  }
}
