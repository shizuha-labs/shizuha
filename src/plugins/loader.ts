/**
 * Plugin Loader — discovers, validates, and loads plugins from disk.
 *
 * Plugin locations (searched in order):
 *  1. ~/.shizuha/plugins/          (user plugins)
 *  2. /opt/shizuha/plugins/        (container-mounted plugins)
 *  3. {workspace}/.shizuha/plugins/ (project plugins, if trusted)
 *
 * Each plugin is a directory containing:
 *  - plugin.json  (manifest: id, name, description, version)
 *  - index.js     (entry point, exports a ShizuhaPlugin object)
 *
 * Security:
 *  - Plugins are loaded in-process (no sandbox) — trust is via allowlist
 *  - Config: plugins.allow = ["plugin-id-1", "plugin-id-2"] or ["*"]
 *  - Unallowed plugins are skipped with a warning
 *  - Path traversal prevented (entry must be within plugin dir)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ToolHandler } from '../tools/types.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { Channel, Inbox } from '../gateway/types.js';
import type { HookConfig, HookEvent } from '../hooks/types.js';
import type { LLMProvider } from '../provider/types.js';
import type { ShizuhaPlugin, PluginApi, PluginEntry, PluginManifest, PluginService } from './types.js';
import { logger } from '../utils/logger.js';

export interface PluginLoaderOptions {
  /** Agent workspace directory */
  workspaceDir: string;
  /** Tool registry to register plugin tools into */
  toolRegistry: ToolRegistry;
  /** Inbox for channel plugins */
  inbox?: Inbox;
  /** Register channel callback */
  onRegisterChannel?: (channel: Channel) => void;
  /** Allowed plugin IDs (empty = none, ['*'] = all) */
  allowList?: string[];
  /** Trust project plugins in workspace/.shizuha/plugins/ */
  trustProjectPlugins?: boolean;
  /** Plugin-specific configs from agent.toml */
  pluginConfigs?: Record<string, Record<string, unknown>>;
}

export class PluginLoader {
  private entries: PluginEntry[] = [];
  private hooks: HookConfig[] = [];
  private services: PluginService[] = [];
  private providerMap = new Map<string, LLMProvider>();

  constructor(private opts: PluginLoaderOptions) {}

  /** Discover and load all plugins. Returns loaded plugin entries. */
  async loadAll(): Promise<PluginEntry[]> {
    const pluginDirs = this.discoverPluginDirs();
    const allowList = this.opts.allowList ?? [];
    const allowAll = allowList.includes('*');

    for (const dir of pluginDirs) {
      try {
        const entry = await this.loadPlugin(dir, allowAll, allowList);
        if (entry) this.entries.push(entry);
      } catch (err) {
        logger.warn({ dir, err: (err as Error).message }, 'Plugin load failed');
      }
    }

    if (this.entries.length > 0) {
      const loaded = this.entries.filter(e => e.status === 'loaded');
      logger.info({
        total: this.entries.length,
        loaded: loaded.length,
        tools: loaded.reduce((s, e) => s + (e.tools?.length ?? 0), 0),
        channels: loaded.reduce((s, e) => s + (e.channels?.length ?? 0), 0),
        hooks: loaded.reduce((s, e) => s + (e.hooks ?? 0), 0),
        services: loaded.reduce((s, e) => s + (e.services?.length ?? 0), 0),
        providers: loaded.reduce((s, e) => s + (e.providers?.length ?? 0), 0),
      }, 'Plugins loaded');
    }

    return this.entries;
  }

  /** Get collected hook configs from all plugins */
  getHooks(): HookConfig[] { return this.hooks; }

  /** Get LLM providers registered by plugins */
  getProviders(): Map<string, LLMProvider> { return this.providerMap; }

  /** Start all registered services */
  async startServices(): Promise<void> {
    for (const svc of this.services) {
      try {
        await svc.start();
        logger.info({ serviceId: svc.id }, 'Plugin service started');
      } catch (err) {
        logger.error({ serviceId: svc.id, err: (err as Error).message }, 'Plugin service start failed');
      }
    }
  }

  /** Stop all services and deactivate plugins */
  async shutdown(): Promise<void> {
    for (const svc of this.services) {
      try { await svc.stop?.(); } catch { /* best effort */ }
    }
    for (const entry of this.entries) {
      try { await entry.plugin.deactivate?.(); } catch { /* best effort */ }
    }
  }

  /** Get all loaded plugin entries */
  getEntries(): PluginEntry[] { return this.entries; }

  // ── Discovery ──

  private discoverPluginDirs(): string[] {
    const dirs: string[] = [];
    const home = process.env['HOME'] ?? '/root';

    // User plugins
    const userDir = path.join(home, '.shizuha', 'plugins');
    if (fs.existsSync(userDir)) {
      for (const d of fs.readdirSync(userDir, { withFileTypes: true })) {
        if (d.isDirectory()) dirs.push(path.join(userDir, d.name));
      }
    }

    // Container-mounted plugins
    const mountDir = '/opt/shizuha/plugins';
    if (fs.existsSync(mountDir)) {
      for (const d of fs.readdirSync(mountDir, { withFileTypes: true })) {
        if (d.isDirectory()) dirs.push(path.join(mountDir, d.name));
      }
    }

    // Project plugins (if trusted)
    if (this.opts.trustProjectPlugins) {
      const projDir = path.join(this.opts.workspaceDir, '.shizuha', 'plugins');
      if (fs.existsSync(projDir)) {
        for (const d of fs.readdirSync(projDir, { withFileTypes: true })) {
          if (d.isDirectory()) dirs.push(path.join(projDir, d.name));
        }
      }
    }

    return dirs;
  }

  // ── Loading ──

  private async loadPlugin(dir: string, allowAll: boolean, allowList: string[]): Promise<PluginEntry | null> {
    // Read manifest
    const manifestPath = path.join(dir, 'plugin.json');
    if (!fs.existsSync(manifestPath)) {
      // Try index.js directly (minimal plugin without manifest)
      const indexPath = path.join(dir, 'index.js');
      if (!fs.existsSync(indexPath)) return null;
    }

    let manifest: PluginManifest;
    if (fs.existsSync(manifestPath)) {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    } else {
      manifest = { id: path.basename(dir) };
    }

    if (!manifest.id) manifest.id = path.basename(dir);

    // Check allowlist
    if (!allowAll && !allowList.includes(manifest.id)) {
      logger.debug({ pluginId: manifest.id }, 'Plugin not in allowlist, skipping');
      return {
        manifest,
        plugin: { id: manifest.id, register() {} },
        status: 'disabled',
        source: dir,
        tools: [], channels: [], hooks: 0, services: [], providers: [],
      };
    }

    // Load module
    const entryPath = path.join(dir, 'index.js');
    if (!fs.existsSync(entryPath)) {
      return {
        manifest,
        plugin: { id: manifest.id, register() {} },
        status: 'error',
        error: 'No index.js found',
        source: dir,
        tools: [], channels: [], hooks: 0, services: [], providers: [],
      };
    }

    // Security: verify entry path is within plugin dir
    const realEntry = fs.realpathSync(entryPath);
    const realDir = fs.realpathSync(dir);
    if (!realEntry.startsWith(realDir)) {
      return {
        manifest,
        plugin: { id: manifest.id, register() {} },
        status: 'error',
        error: 'Plugin entry escapes plugin directory (path traversal)',
        source: dir,
        tools: [], channels: [], hooks: 0, services: [], providers: [],
      };
    }

    let mod: any;
    try {
      mod = require(entryPath);
    } catch (err) {
      return {
        manifest,
        plugin: { id: manifest.id, register() {} },
        status: 'error',
        error: `Load error: ${(err as Error).message}`,
        source: dir,
        tools: [], channels: [], hooks: 0, services: [], providers: [],
      };
    }

    // Resolve plugin object
    const plugin: ShizuhaPlugin = mod.default ?? mod;
    if (!plugin || typeof plugin.register !== 'function') {
      return {
        manifest,
        plugin: { id: manifest.id, register() {} },
        status: 'error',
        error: 'Plugin does not export a register function',
        source: dir,
        tools: [], channels: [], hooks: 0, services: [], providers: [],
      };
    }

    plugin.id = plugin.id ?? manifest.id;

    // Create API and register
    const entry: PluginEntry = {
      manifest,
      plugin,
      status: 'loaded',
      source: dir,
      tools: [], channels: [], hooks: 0, services: [], providers: [],
    };

    const pluginConfig = this.opts.pluginConfigs?.[manifest.id] ?? {};
    const api = this.createApi(manifest.id, dir, pluginConfig, entry);

    try {
      await plugin.register(api);
    } catch (err) {
      entry.status = 'error';
      entry.error = `Register error: ${(err as Error).message}`;
    }

    return entry;
  }

  // ── Plugin API factory ──

  private createApi(
    pluginId: string,
    pluginDir: string,
    config: Record<string, unknown>,
    entry: PluginEntry,
  ): PluginApi {
    return {
      id: pluginId,
      pluginDir,
      workspaceDir: this.opts.workspaceDir,
      config,

      registerTool: (tool: ToolHandler) => {
        // Prefix tool name with plugin ID to avoid conflicts
        const prefixed: ToolHandler = {
          ...tool,
          name: tool.name.startsWith(`plugin__${pluginId}__`)
            ? tool.name
            : `plugin__${pluginId}__${tool.name}`,
          description: `[Plugin: ${pluginId}] ${tool.description}`,
        };
        this.opts.toolRegistry.register(prefixed);
        entry.tools.push(prefixed.name);
      },

      registerChannel: (channel: Channel) => {
        this.opts.onRegisterChannel?.(channel);
        entry.channels.push(channel.id);
      },

      registerHook: (event: HookEvent, command: string, opts?: { matcher?: string; timeout?: number }) => {
        const hook: HookConfig = { event, command, matcher: opts?.matcher, timeout: opts?.timeout };
        this.hooks.push(hook);
        entry.hooks++;
      },

      registerService: (service: PluginService) => {
        this.services.push(service);
        entry.services.push(service.id);
      },

      registerProvider: (name: string, provider: LLMProvider) => {
        this.providerMap.set(name, provider);
        entry.providers.push(name);
        logger.info({ plugin: pluginId, providerName: name }, 'Plugin registered LLM provider');
      },

      log: (msg: string) => logger.info({ plugin: pluginId }, msg),
      warn: (msg: string) => logger.warn({ plugin: pluginId }, msg),
      error: (msg: string) => logger.error({ plugin: pluginId }, msg),
    };
  }
}
