import * as fs from 'node:fs';
import * as path from 'node:path';

// Computed lazily so tests can override process.env.HOME between calls.
function settingsDir(): string {
  return path.join(process.env['HOME'] ?? '~', '.shizuha');
}
function settingsPath(): string {
  return path.join(settingsDir(), 'settings.json');
}

export interface TuiSettings {
  model?: string;
  thinkingLevel?: string;
  reasoningEffort?: string | null;
  fastMode?: boolean;
  permissionMode?: string;
  /** SCLI-479: when false, the TUI does NOT capture the mouse, so the wheel
   *  scrolls tmux/terminal scrollback natively (persisted across restarts). */
  mouseReporting?: boolean;
  /** MCP server names the user turned off in /mcp (persisted across restarts). */
  disabledMcpServers?: string[];
}

let _cache: TuiSettings | null = null;

/** Test/telemetry helper: drop the in-memory cache so the next read re-reads
 *  the settings file (used by tests that swap HOME between cases). */
export function resetSettingsCache(): void {
  _cache = null;
}

export function loadSettings(): TuiSettings {
  if (_cache) return _cache;
  try {
    const raw = fs.readFileSync(settingsPath(), 'utf-8');
    _cache = JSON.parse(raw) as TuiSettings;
    return _cache;
  } catch {
    _cache = {};
    return _cache;
  }
}

export function isMcpServerDisabled(name: string): boolean {
  const disabled = loadSettings().disabledMcpServers ?? [];
  return disabled.includes(name);
}

/** Persist a server's enabled/disabled bit. Returns the new disabled list. */
export function setMcpServerDisabled(name: string, disabled: boolean): string[] {
  const current = new Set(loadSettings().disabledMcpServers ?? []);
  const key = name.trim();
  if (!key) return [...current].sort();
  if (disabled) current.add(key);
  else current.delete(key);
  const list = [...current].sort();
  saveSettings({ disabledMcpServers: list });
  return list;
}

export function saveSettings(partial: Partial<TuiSettings>): void {
  const current = loadSettings();
  const merged = { ...current, ...partial };
  _cache = merged;
  try {
    fs.mkdirSync(settingsDir(), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify(merged, null, 2) + '\n');
  } catch {
    // Silently ignore write failures (read-only fs, permissions, etc.)
  }
}
