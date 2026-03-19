import * as fs from 'node:fs';
import * as path from 'node:path';

const SETTINGS_DIR = path.join(process.env['HOME'] ?? '~', '.shizuha');
const SETTINGS_PATH = path.join(SETTINGS_DIR, 'settings.json');

export interface TuiSettings {
  model?: string;
  thinkingLevel?: string;
  reasoningEffort?: string | null;
  fastMode?: boolean;
  permissionMode?: string;
}

let _cache: TuiSettings | null = null;

export function loadSettings(): TuiSettings {
  if (_cache) return _cache;
  try {
    const raw = fs.readFileSync(SETTINGS_PATH, 'utf-8');
    _cache = JSON.parse(raw) as TuiSettings;
    return _cache;
  } catch {
    _cache = {};
    return _cache;
  }
}

export function saveSettings(partial: Partial<TuiSettings>): void {
  const current = loadSettings();
  const merged = { ...current, ...partial };
  _cache = merged;
  try {
    fs.mkdirSync(SETTINGS_DIR, { recursive: true });
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(merged, null, 2) + '\n');
  } catch {
    // Silently ignore write failures (read-only fs, permissions, etc.)
  }
}
