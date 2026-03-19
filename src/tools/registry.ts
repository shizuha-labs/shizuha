import type { ToolHandler, ToolDefinition } from './types.js';
import { zodToJsonSchema } from 'zod-to-json-schema';

export class ToolRegistry {
  private tools = new Map<string, ToolHandler>();
  private cachedDefinitions: ToolDefinition[] | null = null;

  register(handler: ToolHandler): void {
    if (this.tools.has(handler.name)) {
      throw new Error(`Tool "${handler.name}" already registered`);
    }
    this.tools.set(handler.name, handler);
    this.cachedDefinitions = null;
  }

  get(name: string): ToolHandler | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): ToolHandler[] {
    return [...this.tools.values()];
  }

  /** Generate tool definitions for LLM (JSON Schema from Zod). Cached until registry changes. */
  definitions(): ToolDefinition[] {
    if (this.cachedDefinitions) return this.cachedDefinitions;
    this.cachedDefinitions = this.list().map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: zodToJsonSchema(tool.parameters, { target: 'openApi3' }) as Record<string, unknown>,
    }));
    return this.cachedDefinitions;
  }

  /** Insert or update a tool (for dynamic MCP tool refresh) */
  upsert(handler: ToolHandler): void {
    this.tools.set(handler.name, handler);
    this.cachedDefinitions = null;
  }

  /** Remove a tool */
  unregister(name: string): boolean {
    const deleted = this.tools.delete(name);
    if (deleted) this.cachedDefinitions = null;
    return deleted;
  }

  /** Number of registered tools */
  get size(): number {
    return this.tools.size;
  }
}
