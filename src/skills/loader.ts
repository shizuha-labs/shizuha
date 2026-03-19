/**
 * Skill loader — discovers and parses SKILL.md files.
 *
 * Searches for skills in multiple locations (matching Claude Code + OpenClaw):
 * 1. Project skills: .shizuha/skills/ and .claude/commands/
 * 2. User skills: ~/.shizuha/skills/ and ~/.claude/commands/
 * 3. Bundled skills: (future — shipped with shizuha)
 *
 * File format: YAML frontmatter (---) + Markdown body.
 * Compatible with Claude Code, OpenClaw, and Hermes SKILL.md format.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { Skill, SkillSource, SkillHooks, SkillHookEntry } from './types.js';
import { logger } from '../utils/logger.js';

const MAX_SKILL_FILE_BYTES = 256 * 1024; // 256 KB
const MAX_SKILLS_PER_SOURCE = 200;

export interface LoadSkillsOptions {
  /** Whether to load project-level skills (default: false for security). */
  trustProjectSkills?: boolean;
}

/** Load all skills from project and user directories. */
export function loadSkills(cwd: string, options: LoadSkillsOptions = {}): Skill[] {
  const { trustProjectSkills = false } = options;
  const skills: Skill[] = [];
  const seen = new Set<string>();

  // Project skills (highest priority — override user skills)
  // Only loaded when explicitly trusted to prevent prompt injection from cloned repos
  const projectDirs = [
    path.join(cwd, '.shizuha', 'skills'),
    path.join(cwd, '.claude', 'commands'),
  ];
  if (trustProjectSkills) {
    for (const dir of projectDirs) {
      for (const skill of loadSkillsFromDir(dir, 'project')) {
        if (!seen.has(skill.name)) {
          seen.add(skill.name);
          skills.push(skill);
        }
      }
    }
  } else {
    // Check if project skills exist and warn about them being skipped
    for (const dir of projectDirs) {
      const skipped = loadSkillsFromDir(dir, 'project');
      if (skipped.length > 0) {
        logger.warn(
          { dir, count: skipped.length, names: skipped.map((s) => s.name) },
          'Skipped untrusted project skills. Set [skills] trustProjectSkills = true in config to enable.',
        );
      }
    }
  }

  // User skills — always trusted (user explicitly installed them)
  const home = os.homedir();
  const userDirs = [
    path.join(home, '.shizuha', 'skills'),
    path.join(home, '.claude', 'commands'),
  ];
  for (const dir of userDirs) {
    for (const skill of loadSkillsFromDir(dir, 'user')) {
      if (!seen.has(skill.name)) {
        seen.add(skill.name);
        skills.push(skill);
      }
    }
  }

  // Built-in integration skills — always available
  const integrationSkills: Array<{ name: string; description: string }> = [
    { name: 'github', description: 'GitHub operations via gh CLI: issues, PRs, CI, code review' },
    { name: 'notion', description: 'Notion API: search, create/read pages, query databases' },
    { name: 'trello', description: 'Trello API: boards, cards, lists, comments' },
    { name: 'spotify', description: 'Spotify Web API: playback control, search, now playing' },
  ];
  for (const integ of integrationSkills) {
    if (!seen.has(integ.name)) {
      seen.add(integ.name);
      // Skill content is bundled — resolve from the binary's directory
      const shizuhaDir = path.dirname(process.argv[1] ?? __filename);
      const contentPath = path.join(shizuhaDir, 'skills', 'integrations', `${integ.name}.md`);
      // For bundled builds, the content is embedded — use a fallback description
      skills.push({
        name: integ.name,
        description: integ.description,
        contentPath: fs.existsSync(contentPath) ? contentPath : '',
        skillRoot: path.dirname(contentPath),
        source: 'user' as SkillSource,
      });
    }
  }

  logger.debug({ count: skills.length }, 'Skills loaded');
  return skills;
}

/** Load skills from a single directory. */
function loadSkillsFromDir(dir: string, source: SkillSource): Skill[] {
  if (!fs.existsSync(dir)) return [];

  const skills: Skill[] = [];
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }

  for (const entry of entries) {
    if (skills.length >= MAX_SKILLS_PER_SOURCE) break;

    const entryPath = path.join(dir, entry);
    const stat = safeStat(entryPath);
    if (!stat) continue;

    if (stat.isDirectory()) {
      // Directory-based skill: skills/<name>/SKILL.md
      const skillMd = findSkillFile(entryPath);
      if (skillMd) {
        const skill = parseSkillFile(skillMd, entry, entryPath, source);
        if (skill) skills.push(skill);
      }
    } else if (stat.isFile() && entry.endsWith('.md')) {
      // File-based skill (legacy): commands/<name>.md
      const name = entry.replace(/\.md$/, '');
      const skill = parseSkillFile(entryPath, name, dir, source);
      if (skill) skills.push(skill);
    }
  }

  return skills;
}

/** Find the SKILL.md file in a skill directory (case-insensitive). */
function findSkillFile(dir: string): string | null {
  const candidates = ['SKILL.md', 'skill.md', 'command.md'];
  for (const name of candidates) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** Parse a single SKILL.md file into a Skill definition. */
function parseSkillFile(
  filePath: string,
  fallbackName: string,
  skillRoot: string,
  source: SkillSource,
): Skill | null {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_SKILL_FILE_BYTES) {
      logger.warn({ filePath, size: stat.size }, 'Skill file too large, skipping');
      return null;
    }

    const raw = fs.readFileSync(filePath, 'utf-8');
    const { frontmatter, body } = parseFrontmatter(raw);

    const name = (frontmatter.name as string) ?? fallbackName;
    const description = (frontmatter.description as string) ?? '';

    if (!description) {
      logger.debug({ name, filePath }, 'Skill has no description, skipping');
      return null;
    }

    return {
      name: normalizeName(name),
      description,
      contentPath: filePath,
      skillRoot,
      source,
      model: normalizeModel(frontmatter.model as string | undefined),
      context: frontmatter.context === 'fork' ? 'fork' : undefined,
      allowedTools: parseAllowedTools(frontmatter['allowed-tools']),
      userInvocable: frontmatter['user-invocable'] !== false,
      disableModelInvocation: frontmatter['disable-model-invocation'] === true,
      argumentHint: frontmatter['argument-hint'] as string | undefined,
      whenToUse: (frontmatter.when_to_use ?? frontmatter.whenToUse) as string | undefined,
      version: frontmatter.version as string | undefined,
      hooks: parseHooks(frontmatter.hooks),
    };
  } catch (err) {
    logger.warn({ err, filePath }, 'Failed to parse skill file');
    return null;
  }
}

/** Load the markdown body of a skill (called on invocation, not at discovery). */
export function loadSkillContent(skill: Skill): string {
  const raw = fs.readFileSync(skill.contentPath, 'utf-8');
  const { body } = parseFrontmatter(raw);
  return body.trim();
}

// ── Frontmatter parsing ──

interface ParsedFrontmatter {
  frontmatter: Record<string, unknown>;
  body: string;
}

/** Parse YAML frontmatter from a markdown file. Simple parser — no yaml dependency. */
function parseFrontmatter(content: string): ParsedFrontmatter {
  const trimmed = content.trim();
  if (!trimmed.startsWith('---')) {
    return { frontmatter: {}, body: trimmed };
  }

  const endIdx = trimmed.indexOf('\n---', 3);
  if (endIdx === -1) {
    return { frontmatter: {}, body: trimmed };
  }

  const yamlBlock = trimmed.slice(4, endIdx).trim();
  const body = trimmed.slice(endIdx + 4).trim();

  const frontmatter = parseSimpleYaml(yamlBlock);
  return { frontmatter, body };
}

/**
 * Minimal YAML parser — handles flat key-value pairs and simple arrays.
 * Not a full YAML parser, but sufficient for skill frontmatter.
 */
function parseSimpleYaml(yaml: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = yaml.split('\n');
  let currentKey = '';
  let currentArray: unknown[] | null = null;

  for (const line of lines) {
    // Skip comments and empty lines
    if (line.trim().startsWith('#') || line.trim() === '') continue;

    // Array item
    if (line.match(/^\s+-\s/) && currentKey) {
      const value = line.replace(/^\s+-\s+/, '').trim();
      if (!currentArray) currentArray = [];
      currentArray.push(unquote(value));
      result[currentKey] = currentArray;
      continue;
    }

    // Key-value pair
    const kvMatch = line.match(/^(\S[\w-]*)\s*:\s*(.*)/);
    if (kvMatch) {
      // Save previous array
      currentArray = null;

      const key = kvMatch[1]!;
      const rawValue = kvMatch[2]!.trim();
      currentKey = key;

      if (rawValue === '' || rawValue === '|' || rawValue === '>') {
        // Empty value or block scalar — will be followed by array items or multi-line
        continue;
      }

      // Inline array: [a, b, c]
      if (rawValue.startsWith('[') && rawValue.endsWith(']')) {
        const items = rawValue
          .slice(1, -1)
          .split(',')
          .map((s) => unquote(s.trim()))
          .filter(Boolean);
        result[key] = items;
        continue;
      }

      // Boolean
      if (rawValue === 'true') { result[key] = true; continue; }
      if (rawValue === 'false') { result[key] = false; continue; }

      // String value
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

// ── Helpers ──

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/\s+/g, '-');
}

function normalizeModel(model: string | undefined): string | undefined {
  if (!model || model === 'inherit') return undefined;
  return model;
}

function parseAllowedTools(value: unknown): string[] | undefined {
  if (!value) return undefined;
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === 'string') {
    return value.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return undefined;
}

function parseHooks(value: unknown): Record<string, SkillHookEntry[]> | undefined {
  if (!value || typeof value !== 'object') return undefined;
  // Hooks are complex nested YAML — for now, return undefined
  // Full YAML parser would be needed for nested hook definitions
  return undefined;
}

function safeStat(p: string): fs.Stats | null {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}
