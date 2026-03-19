/**
 * Skill search — discovers and searches skills from the skills repository.
 * Skills are markdown files with YAML frontmatter (name, description, tags).
 * Search uses BM25-style keyword matching over metadata + content.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface SkillIndex {
  name: string;
  description: string;
  tags: string[];
  requires: string[];
  platform?: string;
  env?: string[];
  filePath: string;
}

/** Parse YAML frontmatter from a SKILL.md file */
function parseFrontmatter(content: string): Record<string, unknown> {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const yaml = match[1]!;
  const result: Record<string, unknown> = {};
  for (const line of yaml.split('\n')) {
    const kv = line.match(/^(\w+):\s*(.+)/);
    if (!kv) continue;
    const [, key, value] = kv;
    if (!key || !value) continue;
    // Parse arrays: [a, b, c]
    const arrMatch = value.match(/^\[(.*)\]$/);
    if (arrMatch) {
      result[key] = arrMatch[1]!.split(',').map(s => s.trim().replace(/^["']|["']$/g, ''));
    } else {
      result[key] = value.replace(/^["']|["']$/g, '');
    }
  }
  return result;
}

export class SkillSearchEngine {
  private index: SkillIndex[] = [];
  private usageCount = new Map<string, number>(); // track which skills agent has used

  constructor(private skillsDir: string) {}

  /** Load all skills from the skills directory */
  load(): void {
    this.index = [];
    if (!fs.existsSync(this.skillsDir)) return;

    const dirs = fs.readdirSync(this.skillsDir, { withFileTypes: true })
      .filter(d => d.isDirectory());

    for (const dir of dirs) {
      const skillPath = path.join(this.skillsDir, dir.name, 'SKILL.md');
      if (!fs.existsSync(skillPath)) continue;

      try {
        const content = fs.readFileSync(skillPath, 'utf-8');
        const meta = parseFrontmatter(content);

        this.index.push({
          name: (meta.name as string) || dir.name,
          description: (meta.description as string) || '',
          tags: (meta.tags as string[]) || [],
          requires: (meta.requires as string[]) || [],
          platform: meta.platform as string | undefined,
          env: (meta.env as string[]) || [],
          filePath: skillPath,
        });
      } catch { /* skip malformed */ }
    }
  }

  /** Search skills by query (BM25-style keyword matching) */
  search(query: string, maxResults = 5): Array<SkillIndex & { score: number }> {
    const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 1);

    const scored = this.index.map(skill => {
      let score = 0;
      const name = skill.name.toLowerCase();
      const desc = skill.description.toLowerCase();
      const tags = skill.tags.join(' ').toLowerCase();

      for (const word of words) {
        // Name match (highest weight)
        if (name === word) score += 30;
        else if (name.includes(word)) score += 20;

        // Tag match (high weight)
        if (skill.tags.some(t => t.toLowerCase() === word)) score += 25;
        else if (tags.includes(word)) score += 15;

        // Description match
        if (desc.includes(word)) score += 10;
      }

      // Usage boost — skills the agent has used before rank higher
      const usageBoost = this.usageCount.get(skill.name) ?? 0;
      score += Math.min(usageBoost * 5, 20); // cap at 20

      return { ...skill, score };
    });

    return scored
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults);
  }

  /** Get the full content of a skill */
  getSkillContent(name: string): string | null {
    const skill = this.index.find(s => s.name === name);
    if (!skill) return null;
    try {
      const content = fs.readFileSync(skill.filePath, 'utf-8');
      // Strip frontmatter, return just the body
      const body = content.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
      // Track usage
      this.usageCount.set(name, (this.usageCount.get(name) ?? 0) + 1);
      return body;
    } catch {
      return null;
    }
  }

  /** List all available skills (just names + descriptions) */
  listAll(): Array<{ name: string; description: string; tags: string[] }> {
    return this.index.map(s => ({ name: s.name, description: s.description, tags: s.tags }));
  }

  get count(): number { return this.index.length; }
}

// ── MCP Tool definitions ──

export const SKILL_TOOLS = [
  {
    name: 'search_skills',
    description:
      'Search for skills (knowledge/recipes) by keyword or topic. ' +
      'Skills teach you how to use specific tools, APIs, or workflows.\n' +
      'Use this BEFORE attempting unfamiliar tasks — a skill may already exist.\n\n' +
      'Examples:\n' +
      '  search_skills(query="smart home lights")\n' +
      '  search_skills(query="project management kanban")\n' +
      '  search_skills(query="note taking macos")',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Search query — keywords, topics, or tool names' },
        max_results: { type: 'number', description: 'Max results (default: 5)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'use_skill',
    description:
      'Load a skill by name to get detailed instructions. ' +
      'Use after search_skills finds a relevant skill.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Skill name (from search_skills results)' },
      },
      required: ['name'],
    },
  },
];

export function handleSkillTool(
  engine: SkillSearchEngine,
  name: string,
  args: Record<string, unknown>,
): string {
  switch (name) {
    case 'search_skills': {
      const query = args.query as string;
      const maxResults = (args.max_results as number) || 5;
      const results = engine.search(query, maxResults);
      if (results.length === 0) return `No skills found for "${query}".`;
      return results.map((r, i) =>
        `${i + 1}. **${r.name}** (score: ${r.score})\n   ${r.description}\n   Tags: ${r.tags.join(', ')}`
      ).join('\n\n');
    }

    case 'use_skill': {
      const skillName = args.name as string;
      const content = engine.getSkillContent(skillName);
      if (!content) return `Skill "${skillName}" not found. Use search_skills to find available skills.`;
      return content;
    }

    default:
      return `Unknown skill tool: ${name}`;
  }
}
