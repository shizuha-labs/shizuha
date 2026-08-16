/**
 * Agent template loader — discovers and parses TEMPLATE.md files.
 *
 * Mirrors the skill loader pattern. Searches for templates in:
 * 1. User templates: ~/.shizuha/templates/
 * 2. Mounted templates: /opt/templates/ (inside containers)
 *
 * File format: YAML frontmatter (---) + Markdown body.
 * Frontmatter contains agent config defaults. Body becomes contextPrompt.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { AgentTemplate, TemplateSource } from './types.js';
import { logger } from '../utils/logger.js';

const MAX_TEMPLATE_FILE_BYTES = 512 * 1024; // 512 KB (templates can be large — they contain full system prompts)
const MAX_TEMPLATES_PER_SOURCE = 500;

/** Load all agent templates from user and mounted directories. */
export function loadTemplates(): AgentTemplate[] {
  const templates: AgentTemplate[] = [];
  const seen = new Set<string>();
  const home = os.homedir();

  const dirs = [
    { path: path.join(home, '.shizuha', 'templates'), source: 'user' as TemplateSource },
    { path: '/opt/templates', source: 'bundled' as TemplateSource },
  ];

  for (const { path: dir, source } of dirs) {
    for (const tpl of loadTemplatesFromDir(dir, source)) {
      if (!seen.has(tpl.name)) {
        seen.add(tpl.name);
        templates.push(tpl);
      }
    }
  }

  logger.debug({ count: templates.length }, 'Agent templates loaded');
  return templates;
}

/** Load templates from a single directory. */
function loadTemplatesFromDir(dir: string, source: TemplateSource): AgentTemplate[] {
  if (!fs.existsSync(dir)) return [];

  const templates: AgentTemplate[] = [];
  let entries: string[];
  try { entries = fs.readdirSync(dir); } catch { return []; }

  for (const entry of entries) {
    if (templates.length >= MAX_TEMPLATES_PER_SOURCE) break;
    if (entry === 'registry.json' || entry.startsWith('.')) continue;

    const entryPath = path.join(dir, entry);
    try {
      const stat = fs.statSync(entryPath);
      if (stat.isDirectory()) {
        const mdPath = findTemplateFile(entryPath);
        if (mdPath) {
          const tpl = parseTemplateFile(mdPath, entry, entryPath, source);
          if (tpl) templates.push(tpl);
        }
      }
    } catch { /* skip unreadable entries */ }
  }

  return templates;
}

/** Find TEMPLATE.md in a directory (case-insensitive). */
function findTemplateFile(dir: string): string | null {
  const candidates = ['TEMPLATE.md', 'template.md', 'Template.md'];
  for (const name of candidates) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** Parse a TEMPLATE.md file into an AgentTemplate. */
function parseTemplateFile(
  filePath: string,
  fallbackName: string,
  templateRoot: string,
  source: TemplateSource,
): AgentTemplate | null {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_TEMPLATE_FILE_BYTES) return null;

    const raw = fs.readFileSync(filePath, 'utf-8');
    const { frontmatter, body } = parseFrontmatter(raw);

    const name = (frontmatter.name as string) ?? fallbackName;
    const description = (frontmatter.description as string) ?? '';

    return {
      name,
      description,
      tags: toStringArray(frontmatter.tags),
      category: frontmatter.category as string | undefined,
      requires: toStringArray(frontmatter.requires),
      author: frontmatter.author as string | undefined,
      version: frontmatter.version as string | undefined,
      contentPath: filePath,
      templateRoot,
      source,

      // Agent config defaults
      role: frontmatter.role as string | undefined,
      executionMethod: frontmatter.executionMethod as string | undefined,
      runtimeEnvironment: frontmatter.runtimeEnvironment as string | undefined,
      model: frontmatter.model as string | undefined,
      effort: frontmatter.effort as string | undefined,
      thinking: frontmatter.thinking as string | undefined,
      skills: toStringArray(frontmatter.skills),
      personalityTraits: parseJsonField(frontmatter.personalityTraits),
      modelOverrides: parseJsonField(frontmatter.modelOverrides),
      modelFallbacks: parseJsonField(frontmatter.modelFallbacks),
      mcpServers: toStringArray(frontmatter.mcpServers),
      extraDockerArgs: toStringArray(frontmatter.extraDockerArgs),
      extraVolumes: parseJsonField(frontmatter.extraVolumes),

      // Body is the contextPrompt — stored but loaded lazily in full
      contextPrompt: body || undefined,
    };
  } catch (err) {
    logger.warn({ err, filePath }, 'Failed to parse template file');
    return null;
  }
}

/** Load the full content of a template (body = contextPrompt). */
export function loadTemplateContent(template: AgentTemplate): string {
  if (template.contextPrompt) return template.contextPrompt;
  const raw = fs.readFileSync(template.contentPath, 'utf-8');
  const { body } = parseFrontmatter(raw);
  return body.trim();
}

// ── Frontmatter parsing (reuses skill loader pattern) ──

interface ParsedFrontmatter {
  frontmatter: Record<string, unknown>;
  body: string;
}

function parseFrontmatter(content: string): ParsedFrontmatter {
  const trimmed = content.trim();
  if (!trimmed.startsWith('---')) return { frontmatter: {}, body: trimmed };

  const endIdx = trimmed.indexOf('\n---', 3);
  if (endIdx === -1) return { frontmatter: {}, body: trimmed };

  const yamlBlock = trimmed.slice(4, endIdx).trim();
  const body = trimmed.slice(endIdx + 4).trim();

  return { frontmatter: parseSimpleYaml(yamlBlock), body };
}

/**
 * Minimal YAML parser — handles flat key-value, inline arrays, and JSON values.
 * For complex nested objects (personalityTraits, extraVolumes), values should
 * be written as inline JSON in the frontmatter.
 */
function parseSimpleYaml(yaml: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = yaml.split('\n');
  let currentKey = '';
  let currentArray: unknown[] | null = null;

  for (const line of lines) {
    if (line.trim().startsWith('#') || line.trim() === '') continue;

    // Array item (- value)
    if (line.match(/^\s+-\s/) && currentKey) {
      const value = line.replace(/^\s+-\s+/, '').trim();
      if (!currentArray) currentArray = [];
      // Try parsing as JSON object (for extraVolumes items)
      const parsed = tryParseJson(value);
      currentArray.push(parsed !== undefined ? parsed : unquote(value));
      result[currentKey] = currentArray;
      continue;
    }

    // Key-value pair
    const kvMatch = line.match(/^(\S[\w-]*)\s*:\s*(.*)/);
    if (kvMatch) {
      currentArray = null;
      const key = kvMatch[1]!;
      const rawValue = kvMatch[2]!.trim();
      currentKey = key;

      if (rawValue === '' || rawValue === '|' || rawValue === '>') continue;

      // Inline array: [a, b, c]
      if (rawValue.startsWith('[') && rawValue.endsWith(']')) {
        // Try as JSON first (handles nested objects in arrays)
        const jsonParsed = tryParseJson(rawValue);
        if (jsonParsed !== undefined) {
          result[key] = jsonParsed;
        } else {
          result[key] = rawValue.slice(1, -1).split(',').map((s) => unquote(s.trim())).filter(Boolean);
        }
        continue;
      }

      // Inline object: {key: value, ...}
      if (rawValue.startsWith('{') && rawValue.endsWith('}')) {
        const jsonParsed = tryParseJson(rawValue);
        if (jsonParsed !== undefined) { result[key] = jsonParsed; continue; }
      }

      // Boolean
      if (rawValue === 'true') { result[key] = true; continue; }
      if (rawValue === 'false') { result[key] = false; continue; }

      result[key] = unquote(rawValue);
    }
  }
  return result;
}

function unquote(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

function tryParseJson(s: string): unknown | undefined {
  try { return JSON.parse(s); } catch { return undefined; }
}

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string') return value.split(',').map((s) => s.trim()).filter(Boolean);
  return [];
}

function parseJsonField<T>(value: unknown): T | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'object') return value as T;
  if (typeof value === 'string') {
    try { return JSON.parse(value) as T; } catch { return undefined; }
  }
  return undefined;
}
