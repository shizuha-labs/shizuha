import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse as parseTOML } from 'smol-toml';

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function projectConfigDirs(cwd = process.cwd()): string[] {
  const parent = path.dirname(cwd);
  return uniqueStrings([
    parent,
    path.join(parent, 'shizuha'),
    cwd,
    path.join(cwd, 'shizuha'),
  ]);
}

function configCandidates(cwd = process.cwd()): string[] {
  const home = process.env['HOME'] ?? '~';
  const candidates = [
    '/etc/shizuha/config.toml',
    path.join(home, '.config', 'shizuha', 'config.toml'),
  ];

  for (const dir of projectConfigDirs(cwd)) {
    candidates.push(path.join(dir, '.shizuha', 'config.toml'));
    candidates.push(path.join(dir, '.shizuha', 'config.local.toml'));
  }

  return uniqueStrings(candidates);
}

export function readProviderConfigValue(providerName: string, key: string, cwd = process.cwd()): string | undefined {
  let resolved: string | undefined;

  for (const filePath of configCandidates(cwd)) {
    try {
      if (!fs.existsSync(filePath)) continue;
      const raw = fs.readFileSync(filePath, 'utf-8');
      const parsed = parseTOML(raw) as Record<string, unknown>;
      const providers = parsed['providers'] as Record<string, unknown> | undefined;
      const provider = providers?.[providerName] as Record<string, unknown> | undefined;
      const value = provider?.[key];
      if (typeof value === 'string' && value.trim()) {
        resolved = value.trim();
      }
    } catch {
      // Ignore malformed or unreadable optional config layers.
    }
  }

  return resolved;
}
