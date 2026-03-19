/**
 * Plugin SDK types — the interface that plugins implement.
 *
 * Plugins can register:
 *  - Tools (agent-callable functions)
 *  - Channels (messaging integrations)
 *  - Hooks (lifecycle event handlers)
 *  - Services (long-running background tasks)
 *  - Providers (LLM providers — e.g., Claude Code OAuth)
 */

import type { ToolHandler } from '../tools/types.js';
import type { Channel } from '../gateway/types.js';
import type { HookEvent, HookConfig } from '../hooks/types.js';
import type { LLMProvider } from '../provider/types.js';

// ── Plugin metadata ──

export interface PluginManifest {
  id: string;
  name?: string;
  description?: string;
  version?: string;
}

// ── Plugin API (passed to register function) ──

export interface PluginApi {
  /** Plugin ID */
  id: string;
  /** Plugin root directory */
  pluginDir: string;
  /** Agent workspace directory */
  workspaceDir: string;
  /** Plugin-specific config (from agent.toml or plugin.json) */
  config: Record<string, unknown>;

  /** Register a tool for agents to use */
  registerTool(tool: ToolHandler): void;

  /** Register a messaging channel */
  registerChannel(channel: Channel): void;

  /** Register a lifecycle hook */
  registerHook(event: HookEvent, command: string, opts?: { matcher?: string; timeout?: number }): void;

  /** Register a background service */
  registerService(service: PluginService): void;

  /**
   * Register an LLM provider.
   * Plugin providers are merged into the ProviderRegistry after built-in
   * providers. Registering under an existing name (e.g. 'anthropic')
   * overrides the built-in provider for that name.
   */
  registerProvider(name: string, provider: LLMProvider): void;

  /** Log a message (prefixed with plugin ID) */
  log(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface PluginService {
  id: string;
  start(): Promise<void> | void;
  stop?(): Promise<void> | void;
}

// ── Plugin definition (what a plugin exports) ──

export interface ShizuhaPlugin {
  /** Plugin metadata */
  id: string;
  name?: string;
  description?: string;
  version?: string;

  /** Called during agent startup to register tools/channels/hooks */
  register(api: PluginApi): void | Promise<void>;

  /** Called when agent shuts down */
  deactivate?(): void | Promise<void>;
}

// ── Plugin registry entry (internal) ──

export interface PluginEntry {
  manifest: PluginManifest;
  plugin: ShizuhaPlugin;
  status: 'loaded' | 'error' | 'disabled';
  error?: string;
  source: string; // file path
  tools: string[]; // registered tool names
  channels: string[]; // registered channel IDs
  hooks: number; // hook count
  services: string[]; // service IDs
  providers: string[]; // registered provider names
}
