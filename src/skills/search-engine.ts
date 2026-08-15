/**
 * Skill search — discovers and searches skills from the skills repository.
 * Skills are directories containing SKILL.md with YAML frontmatter.
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

/** Parse YAML frontmatter from a SKILL.md file. */
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
  private usageCount = new Map<string, number>();

  constructor(private skillsDir: string) {}

  /** Load all skills from the skills directory. */
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

  /** Load skills from an additional directory. */
  loadFrom(dir: string): void {
    if (!fs.existsSync(dir)) return;
    const seen = new Set(this.index.map(s => s.name));
    const dirs = fs.readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory());
    for (const d of dirs) {
      const skillPath = path.join(dir, d.name, 'SKILL.md');
      if (!fs.existsSync(skillPath)) continue;
      try {
        const content = fs.readFileSync(skillPath, 'utf-8');
        const meta = parseFrontmatter(content);
        const name = (meta.name as string) || d.name;
        if (seen.has(name)) continue;
        this.index.push({
          name,
          description: (meta.description as string) || '',
          tags: (meta.tags as string[]) || [],
          requires: (meta.requires as string[]) || [],
          platform: meta.platform as string | undefined,
          env: (meta.env as string[]) || [],
          filePath: skillPath,
        });
        seen.add(name);
      } catch { /* skip malformed */ }
    }
  }

  /** @deprecated Use loadFrom() instead. */
  loadIntegrationSkills(dir: string): number {
    if (!fs.existsSync(dir)) return 0;
    const seen = new Set(this.index.map(s => s.name));
    let added = 0;
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.md')) continue;
      const filePath = path.join(dir, file);
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const meta = parseFrontmatter(content);
        const name = (meta.name as string) || file.replace(/\.md$/, '');
        if (seen.has(name)) continue;
        this.index.push({
          name,
          description: (meta.description as string) || '',
          tags: (meta.tags as string[]) || [],
          requires: (meta.requires as string[]) || [],
          platform: meta.platform as string | undefined,
          env: (meta.env as string[]) || [],
          filePath,
        });
        seen.add(name);
        added++;
      } catch { /* skip malformed */ }
    }
    return added;
  }

  /** Reload skills from disk. */
  reload(): number {
    const before = this.index.length;
    this.load();
    return this.index.length - before;
  }

  /** Search skills by query. */
  search(query: string, maxResults = 5): Array<SkillIndex & { score: number }> {
    if (fs.existsSync(this.skillsDir)) {
      const dirs = fs.readdirSync(this.skillsDir, { withFileTypes: true }).filter(d => d.isDirectory()).length;
      if (dirs > this.index.length) this.load();
    }

    const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 1);
    const scored = this.index.map(skill => {
      let score = 0;
      const name = skill.name.toLowerCase();
      const desc = skill.description.toLowerCase();
      const tags = skill.tags.join(' ').toLowerCase();

      for (const word of words) {
        if (name === word) score += 30;
        else if (name.includes(word)) score += 20;

        if (skill.tags.some(t => t.toLowerCase() === word)) score += 25;
        else if (tags.includes(word)) score += 15;

        if (desc.includes(word)) score += 10;
      }

      const usageBoost = this.usageCount.get(skill.name) ?? 0;
      score += Math.min(usageBoost * 5, 20);
      return { ...skill, score };
    });

    return scored
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults);
  }

  /** Get the full content of a skill. */
  getSkillContent(name: string): string | null {
    const skill = this.index.find(s => s.name === name);
    if (!skill) return null;
    try {
      const content = fs.readFileSync(skill.filePath, 'utf-8');
      const body = content.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
      this.usageCount.set(name, (this.usageCount.get(name) ?? 0) + 1);
      return body;
    } catch {
      return null;
    }
  }

  /** List all available skills. */
  listAll(): Array<{ name: string; description: string; tags: string[] }> {
    return this.index.map(s => ({ name: s.name, description: s.description, tags: s.tags }));
  }

  get count(): number { return this.index.length; }
}
