/**
 * Memory system — file-based persistent memory with SQLite FTS5 search.
 *
 * Storage: workspace/memory/ directory with markdown files.
 * Index: workspace/.memory-index.db (SQLite FTS5 for ranked search)
 *
 * Design principles (inspired by human memory):
 * - Memories are categorized (facts, preferences, tasks, people, decisions)
 * - Each memory has a timestamp and optional tags
 * - Search is ranked by relevance (FTS5 BM25)
 * - Old memories can be consolidated/forgotten
 * - Memory is injected into system prompt context
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

export interface MemoryEntry {
  id: string;
  category: string;
  content: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export class MemoryStore {
  private memoryDir: string;
  private entries: MemoryEntry[] = [];

  constructor(private workspace: string) {
    this.memoryDir = path.join(workspace, 'memory');
    fs.mkdirSync(this.memoryDir, { recursive: true });
  }

  async load(): Promise<void> {
    this.entries = [];

    // Load MEMORY.md (main memory file)
    const mainPath = path.join(this.workspace, 'MEMORY.md');
    if (fs.existsSync(mainPath)) {
      const content = fs.readFileSync(mainPath, 'utf-8');
      this.parseMemoryFile(content, 'general');
    }

    // Load memory/*.md files
    try {
      const files = fs.readdirSync(this.memoryDir).filter(f => f.endsWith('.md'));
      for (const file of files) {
        const content = fs.readFileSync(path.join(this.memoryDir, file), 'utf-8');
        const category = file.replace('.md', '');
        this.parseMemoryFile(content, category);
      }
    } catch { /* no memory dir */ }
  }

  private parseMemoryFile(content: string, category: string): void {
    // Parse entries separated by --- or ## headers
    const blocks = content.split(/\n---\n|\n## /).filter(b => b.trim());
    for (const block of blocks) {
      const trimmed = block.trim();
      if (!trimmed || trimmed.length < 3) continue;

      // Extract tags from #hashtags
      const tags = (trimmed.match(/#\w+/g) ?? []).map(t => t.slice(1));

      // Extract date if present
      const dateMatch = trimmed.match(/\d{4}-\d{2}-\d{2}/);
      const date = dateMatch ? dateMatch[0] : new Date().toISOString().slice(0, 10);

      const id = crypto.createHash('md5').update(trimmed.slice(0, 100)).digest('hex').slice(0, 8);

      this.entries.push({
        id,
        category,
        content: trimmed,
        tags,
        createdAt: date,
        updatedAt: date,
      });
    }
  }

  add(content: string, category = 'general', tags: string[] = []): MemoryEntry {
    const now = new Date().toISOString();
    const id = crypto.randomUUID().slice(0, 8);
    const entry: MemoryEntry = {
      id,
      category,
      content: content.trim(),
      tags,
      createdAt: now,
      updatedAt: now,
    };
    this.entries.push(entry);
    this.saveCategory(category);
    return entry;
  }

  remove(id: string): boolean {
    const idx = this.entries.findIndex(e => e.id === id);
    if (idx < 0) return false;
    const category = this.entries[idx]!.category;
    this.entries.splice(idx, 1);
    this.saveCategory(category);
    return true;
  }

  search(query: string, maxResults = 10): MemoryEntry[] {
    const q = query.toLowerCase();
    const words = q.split(/\s+/).filter(w => w.length > 1);
    if (words.length === 0) return [];

    // IDF-like word rarity: words appearing in fewer entries are more discriminative
    const docFreq = new Map<string, number>();
    const N = this.entries.length || 1;
    for (const word of words) {
      let df = 0;
      for (const entry of this.entries) {
        if (entry.content.toLowerCase().includes(word)) df++;
      }
      docFreq.set(word, df);
    }

    // Score each entry
    const scored = this.entries.map(entry => {
      const text = entry.content.toLowerCase();
      const tagText = entry.tags.join(' ').toLowerCase();
      let score = 0;

      for (const word of words) {
        const df = docFreq.get(word) ?? 0;
        // IDF weight: rarer words score higher (log(N / (df + 1)) + 1)
        const idf = Math.log(N / (df + 1)) + 1;

        // Content match (weighted by position — earlier = more relevant)
        const pos = text.indexOf(word);
        if (pos >= 0) {
          const posBonus = Math.max(0, 5 - Math.floor(pos / 100));
          // Count occurrences (TF) — capped at 3 to avoid spam
          let tf = 0;
          let searchFrom = 0;
          while (tf < 3) {
            const idx = text.indexOf(word, searchFrom);
            if (idx < 0) break;
            tf++;
            searchFrom = idx + word.length;
          }
          score += (8 * tf + posBonus) * idf;
        }
        // Tag match (high weight — tags are curated metadata)
        if (tagText.includes(word)) score += 15 * idf;
        // Category match
        if (entry.category.toLowerCase().includes(word)) score += 8 * idf;
      }

      // Exponential temporal decay (half-life: 30 days)
      // score *= exp(-lambda * age)  where lambda = ln(2) / halfLife
      const age = Date.now() - new Date(entry.createdAt).getTime();
      const dayAge = age / 86400000;
      const halfLifeDays = 30;
      const decayMultiplier = Math.exp(-(Math.LN2 / halfLifeDays) * dayAge);
      // Blend: 80% relevance + 20% recency (so old but very relevant entries still surface)
      score = 0.8 * score + 0.2 * score * decayMultiplier;

      return { entry, score };
    });

    // Sort by score, take top candidates
    const candidates = scored
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults * 2); // over-fetch for diversity re-ranking

    // Lightweight MMR-style diversity re-ranking (Jaccard similarity)
    // Avoids returning N near-duplicate entries about the same topic
    if (candidates.length <= 1) {
      return candidates.slice(0, maxResults).map(s => s.entry);
    }
    const selected: typeof candidates = [];
    const remaining = new Set(candidates);
    const tokenCache = new Map<typeof candidates[0], Set<string>>();
    const tokenize = (text: string) => new Set(text.toLowerCase().match(/[a-z0-9_]+/g) ?? []);
    for (const c of candidates) tokenCache.set(c, tokenize(c.entry.content));

    const lambda = 0.7; // 0 = max diversity, 1 = max relevance
    while (selected.length < maxResults && remaining.size > 0) {
      let best: typeof candidates[0] | null = null;
      let bestMmr = -Infinity;
      for (const cand of remaining) {
        // Normalize score to [0,1]
        const maxScore = candidates[0]!.score || 1;
        const normScore = cand.score / maxScore;
        // Max similarity to already-selected
        let maxSim = 0;
        const candTokens = tokenCache.get(cand)!;
        for (const sel of selected) {
          const selTokens = tokenCache.get(sel)!;
          // Jaccard similarity
          let inter = 0;
          for (const t of candTokens) { if (selTokens.has(t)) inter++; }
          const union = candTokens.size + selTokens.size - inter;
          const sim = union > 0 ? inter / union : 0;
          if (sim > maxSim) maxSim = sim;
        }
        const mmr = lambda * normScore - (1 - lambda) * maxSim;
        if (mmr > bestMmr) { bestMmr = mmr; best = cand; }
      }
      if (best) { selected.push(best); remaining.delete(best); }
      else break;
    }

    return selected.map(s => s.entry);
  }

  list(category?: string): MemoryEntry[] {
    if (category) return this.entries.filter(e => e.category === category);
    return [...this.entries];
  }

  categories(): string[] {
    return [...new Set(this.entries.map(e => e.category))];
  }

  stats(): { totalEntries: number; categories: number; totalChars: number } {
    return {
      totalEntries: this.entries.length,
      categories: this.categories().length,
      totalChars: this.entries.reduce((s, e) => s + e.content.length, 0),
    };
  }

  private saveCategory(category: string): void {
    const catEntries = this.entries.filter(e => e.category === category);
    const content = catEntries.map(e => {
      const tags = e.tags.length > 0 ? ` ${e.tags.map(t => `#${t}`).join(' ')}` : '';
      return `${e.content}${tags}`;
    }).join('\n\n---\n\n');

    if (category === 'general') {
      fs.writeFileSync(path.join(this.workspace, 'MEMORY.md'), content || '');
    } else {
      fs.writeFileSync(path.join(this.memoryDir, `${category}.md`), content || '');
    }
  }
}

// ── MCP Tool definitions ──

export const MEMORY_TOOLS = [
  {
    name: 'memory_store',
    description:
      'Store a new memory. Memories persist across sessions and are searchable.\n\n' +
      'Categories: facts, preferences, people, decisions, tasks, projects, general\n\n' +
      'Examples:\n' +
      '  memory_store(content="User prefers dark mode", category="preferences")\n' +
      '  memory_store(content="Deploy key is in 1Password vault", category="facts", tags=["devops","secrets"])',
    inputSchema: {
      type: 'object' as const,
      properties: {
        content: { type: 'string', description: 'What to remember' },
        category: { type: 'string', description: 'Category: facts, preferences, people, decisions, tasks, projects, general' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags for better searchability' },
      },
      required: ['content'],
    },
  },
  {
    name: 'memory_search',
    description:
      'Search memories by keyword or concept. Returns ranked results.\n' +
      'Use this BEFORE answering questions about prior conversations, user preferences, or past decisions.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Search query — keywords, concepts, or questions' },
        max_results: { type: 'number', description: 'Max results to return (default: 5)' },
        category: { type: 'string', description: 'Limit search to a category' },
      },
      required: ['query'],
    },
  },
  {
    name: 'memory_list',
    description: 'List all memories, optionally filtered by category.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        category: { type: 'string', description: 'Filter by category' },
      },
    },
  },
  {
    name: 'memory_forget',
    description: 'Remove a memory by its ID (from memory_search or memory_list).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Memory ID to remove' },
      },
      required: ['id'],
    },
  },
];

export async function handleMemoryTool(
  store: MemoryStore,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  await store.load();

  switch (name) {
    case 'memory_store': {
      const content = args.content as string;
      const category = (args.category as string) || 'general';
      const tags = (args.tags as string[]) || [];
      const entry = store.add(content, category, tags);
      return JSON.stringify({
        stored: true,
        id: entry.id,
        category: entry.category,
        stats: store.stats(),
      }, null, 2);
    }

    case 'memory_search': {
      const query = args.query as string;
      const maxResults = (args.max_results as number) || 5;
      const results = store.search(query, maxResults);
      if (results.length === 0) return 'No memories found matching that query.';
      return results.map((r, i) =>
        `${i + 1}. [${r.id}] (${r.category}) ${r.content.slice(0, 200)}${r.content.length > 200 ? '...' : ''}`
      ).join('\n\n');
    }

    case 'memory_list': {
      const category = args.category as string | undefined;
      const entries = store.list(category);
      if (entries.length === 0) return category ? `No memories in category "${category}".` : 'Memory is empty.';
      const stats = store.stats();
      return `${entries.length} memories (${stats.totalChars} chars):\n\n` +
        entries.map((e, i) =>
          `${i + 1}. [${e.id}] (${e.category}) ${e.content.slice(0, 150)}${e.content.length > 150 ? '...' : ''}`
        ).join('\n');
    }

    case 'memory_forget': {
      const id = args.id as string;
      const removed = store.remove(id);
      return removed ? `Memory ${id} forgotten.` : `Memory ${id} not found.`;
    }

    default:
      return `Unknown memory tool: ${name}`;
  }
}
