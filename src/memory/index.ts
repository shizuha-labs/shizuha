/**
 * Memory Index — persistent, searchable memory for agents.
 *
 * Three-layer architecture (inspired by OpenClaw's memsearch):
 *
 * 1. **FTS5 keyword search** — SQLite full-text search, zero external deps
 * 2. **Vector embeddings** — sqlite-vec + OpenAI text-embedding-3-small
 * 3. **Hybrid merge** — weighted combination (70% vector + 30% keyword)
 *
 * Sources indexed:
 * - MEMORY.md (workspace root)
 * - memory/*.md (categorized memories)
 * - Session transcripts (NDJSON, optional)
 *
 * Configurable per agent via agent.toml:
 *   [memory]
 *   vectorEnabled = true          # enable/disable embeddings
 *   embeddingModel = "text-embedding-3-small"
 *   vectorWeight = 0.7
 *   textWeight = 0.3
 *   temporalDecay = true
 *   halfLifeDays = 30
 *   mmrEnabled = false
 *   mmrLambda = 0.7
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import Database from 'better-sqlite3';

// ── Types ──

export interface MemoryChunk {
  id: string;
  path: string;
  source: 'memory' | 'sessions';
  startLine: number;
  endLine: number;
  text: string;
  hash: string;
  embedding?: number[];
}

export interface MemorySearchResult {
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  snippet: string;
  source: 'memory' | 'sessions';
}

export interface MemoryIndexConfig {
  /** Enable vector embeddings (requires API key) */
  vectorEnabled?: boolean;
  /** Embedding model (default: text-embedding-3-small) */
  embeddingModel?: string;
  /** Embedding dimensions (default: 1536, use 512 for smaller index) */
  embeddingDimensions?: number;
  /** API key for embeddings (OpenAI) */
  embeddingApiKey?: string;
  /** Hybrid weight for vector results (default: 0.7) */
  vectorWeight?: number;
  /** Hybrid weight for keyword results (default: 0.3) */
  textWeight?: number;
  /** Enable temporal decay (default: true) */
  temporalDecay?: boolean;
  /** Decay half-life in days (default: 30) */
  halfLifeDays?: number;
  /** Enable MMR diversity re-ranking (default: false) */
  mmrEnabled?: boolean;
  /** MMR lambda: 0=max diversity, 1=max relevance (default: 0.7) */
  mmrLambda?: number;
  /** Max tokens per chunk (default: 400) */
  chunkTokens?: number;
  /** Overlap tokens between chunks (default: 80) */
  chunkOverlap?: number;
  /** Index session transcripts (default: false) */
  indexSessions?: boolean;
}

const DEFAULTS: Required<MemoryIndexConfig> = {
  vectorEnabled: false,
  embeddingModel: 'text-embedding-3-small',
  embeddingDimensions: 1536,
  embeddingApiKey: '',
  vectorWeight: 0.7,
  textWeight: 0.3,
  temporalDecay: true,
  halfLifeDays: 30,
  mmrEnabled: false,
  mmrLambda: 0.7,
  chunkTokens: 400,
  chunkOverlap: 80,
  indexSessions: false,
};

// ── Chunking ──

interface ChunkInfo {
  startLine: number;
  endLine: number;
  text: string;
  hash: string;
}

function chunkMarkdown(content: string, maxChars: number, overlapChars: number): ChunkInfo[] {
  const lines = content.split('\n');
  const chunks: ChunkInfo[] = [];
  let currentLines: string[] = [];
  let currentChars = 0;
  let startLine = 1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    currentLines.push(line);
    currentChars += line.length + 1;

    if (currentChars >= maxChars) {
      const text = currentLines.join('\n').trim();
      if (text.length > 10) {
        chunks.push({
          startLine,
          endLine: i + 1,
          text,
          hash: crypto.createHash('sha256').update(text).digest('hex').slice(0, 16),
        });
      }

      // Overlap: keep last N chars worth of lines
      const overlapLines: string[] = [];
      let overlapTotal = 0;
      for (let j = currentLines.length - 1; j >= 0; j--) {
        overlapTotal += currentLines[j]!.length + 1;
        if (overlapTotal > overlapChars) break;
        overlapLines.unshift(currentLines[j]!);
      }

      currentLines = overlapLines;
      currentChars = overlapLines.reduce((s, l) => s + l.length + 1, 0);
      startLine = i + 2 - overlapLines.length;
    }
  }

  // Flush remaining
  const text = currentLines.join('\n').trim();
  if (text.length > 10) {
    chunks.push({
      startLine,
      endLine: lines.length,
      text,
      hash: crypto.createHash('sha256').update(text).digest('hex').slice(0, 16),
    });
  }

  return chunks;
}

// ── BM25 helpers ──

function buildFtsQuery(raw: string): string | null {
  const tokens = raw.match(/[\p{L}\p{N}_]+/gu)?.map(t => t.trim()).filter(Boolean) ?? [];
  if (tokens.length === 0) return null;
  return tokens.map(t => `"${t.replace(/"/g, '')}"`).join(' AND ');
}

function bm25RankToScore(rank: number): number {
  if (!Number.isFinite(rank)) return 1 / (1 + 999);
  if (rank < 0) {
    const relevance = -rank;
    return relevance / (1 + relevance);
  }
  return 1 / (1 + rank);
}

// ── Temporal decay ──

function temporalDecayMultiplier(ageInDays: number, halfLifeDays: number): number {
  if (halfLifeDays <= 0 || !Number.isFinite(ageInDays)) return 1;
  const lambda = Math.LN2 / halfLifeDays;
  return Math.exp(-lambda * Math.max(0, ageInDays));
}

// ── MMR ──

function tokenize(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[a-z0-9_]+/g) ?? []);
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  const smaller = a.size <= b.size ? a : b;
  const larger = a.size <= b.size ? b : a;
  for (const t of smaller) { if (larger.has(t)) inter++; }
  const union = a.size + b.size - inter;
  return union > 0 ? inter / union : 0;
}

function mmrRerank<T extends { score: number; snippet: string }>(items: T[], lambda: number): T[] {
  if (items.length <= 1) return [...items];

  const tokenCache = new Map<T, Set<string>>();
  for (const item of items) tokenCache.set(item, tokenize(item.snippet));

  const maxScore = Math.max(...items.map(i => i.score));
  const minScore = Math.min(...items.map(i => i.score));
  const range = maxScore - minScore;
  const norm = (s: number) => range === 0 ? 1 : (s - minScore) / range;

  const selected: T[] = [];
  const remaining = new Set(items);

  while (remaining.size > 0) {
    let best: T | null = null;
    let bestMmr = -Infinity;

    for (const cand of remaining) {
      const relevance = norm(cand.score);
      let maxSim = 0;
      const candTokens = tokenCache.get(cand)!;
      for (const sel of selected) {
        const sim = jaccardSimilarity(candTokens, tokenCache.get(sel)!);
        if (sim > maxSim) maxSim = sim;
      }
      const mmr = lambda * relevance - (1 - lambda) * maxSim;
      if (mmr > bestMmr || (mmr === bestMmr && cand.score > (best?.score ?? -Infinity))) {
        bestMmr = mmr;
        best = cand;
      }
    }

    if (best) { selected.push(best); remaining.delete(best); }
    else break;
  }
  return selected;
}

// ── Cosine similarity (fallback when sqlite-vec not available) ──

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 0 ? dot / denom : 0;
}

// ── Embedding provider ──

async function embedTexts(
  texts: string[],
  apiKey: string,
  model: string,
  dimensions?: number,
): Promise<number[][]> {
  if (!apiKey || texts.length === 0) return [];

  const body: Record<string, unknown> = { model, input: texts };
  if (dimensions) body.dimensions = dimensions;

  const resp = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`Embedding API error ${resp.status}: ${errText.slice(0, 200)}`);
  }

  const data = await resp.json() as { data: Array<{ embedding: number[]; index: number }> };
  // Sort by index to match input order
  return data.data.sort((a, b) => a.index - b.index).map(d => d.embedding);
}

// ── Main class ──

export class MemoryIndex {
  private db: Database.Database;
  private cfg: Required<MemoryIndexConfig>;
  private workspace: string;
  private hasVecExtension = false;

  constructor(workspace: string, config?: MemoryIndexConfig) {
    this.workspace = workspace;
    this.cfg = { ...DEFAULTS, ...config };

    // Resolve API key from config or env
    // Priority: explicit config > EMBEDDING_API_KEY > OPENAI_API_KEY > Codex OAuth access_token
    if (!this.cfg.embeddingApiKey) {
      this.cfg.embeddingApiKey =
        process.env['EMBEDDING_API_KEY'] ??
        process.env['OPENAI_API_KEY'] ??
        '';

      // Try Codex OAuth token as fallback (audience: api.openai.com/v1)
      if (!this.cfg.embeddingApiKey) {
        try {
          const codexAuthPath = path.join(process.env['HOME'] ?? '~', '.codex', 'auth.json');
          if (fs.existsSync(codexAuthPath)) {
            const auth = JSON.parse(fs.readFileSync(codexAuthPath, 'utf-8'));
            if (auth.access_token) this.cfg.embeddingApiKey = auth.access_token;
          }
        } catch { /* ignore */ }
      }

      // Try credentials.json Codex accounts
      if (!this.cfg.embeddingApiKey) {
        try {
          const credsPath = path.join(process.env['HOME'] ?? '~', '.shizuha', 'credentials.json');
          if (fs.existsSync(credsPath)) {
            const creds = JSON.parse(fs.readFileSync(credsPath, 'utf-8'));
            const accounts = creds?.codex?.accounts ?? [];
            if (accounts[0]?.accessToken) this.cfg.embeddingApiKey = accounts[0].accessToken;
          }
        } catch { /* ignore */ }
      }
    }

    const dbPath = path.join(workspace, '.memory-index.db');
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');

    this.initSchema();
    this.tryLoadVecExtension();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS files (
        path TEXT PRIMARY KEY,
        source TEXT NOT NULL DEFAULT 'memory',
        hash TEXT NOT NULL,
        mtime INTEGER NOT NULL,
        size INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS chunks (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'memory',
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        hash TEXT NOT NULL,
        model TEXT NOT NULL DEFAULT '',
        text TEXT NOT NULL,
        embedding TEXT NOT NULL DEFAULT '[]',
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_chunks_path ON chunks(path);
      CREATE INDEX IF NOT EXISTS idx_chunks_source ON chunks(source);

      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
        text,
        id UNINDEXED,
        path UNINDEXED,
        source UNINDEXED,
        start_line UNINDEXED,
        end_line UNINDEXED
      );

      CREATE TABLE IF NOT EXISTS embedding_cache (
        model TEXT NOT NULL,
        hash TEXT NOT NULL,
        embedding TEXT NOT NULL,
        dims INTEGER,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (model, hash)
      );
    `);
  }

  private tryLoadVecExtension(): void {
    if (!this.cfg.vectorEnabled) return;
    try {
      // Dynamic import of sqlite-vec
      const sqliteVec = require('sqlite-vec');
      sqliteVec.load(this.db);
      this.hasVecExtension = true;

      // Create vector table if needed
      const dims = this.cfg.embeddingDimensions;
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(
          id TEXT PRIMARY KEY,
          embedding float[${dims}]
        );
      `);
    } catch {
      // sqlite-vec not available — fall back to in-memory cosine similarity
      this.hasVecExtension = false;
    }
  }

  // ── Indexing ──

  /** Sync all memory files into the index. */
  async sync(): Promise<{ indexed: number; removed: number; embedded: number }> {
    const files = this.discoverFiles();
    let indexed = 0;
    let removed = 0;
    let embedded = 0;

    const existingPaths = new Set(
      (this.db.prepare('SELECT path FROM files').all() as Array<{ path: string }>).map(r => r.path)
    );

    // Index new/changed files
    for (const file of files) {
      const content = fs.readFileSync(path.join(this.workspace, file.path), 'utf-8');
      const hash = crypto.createHash('sha256').update(content).digest('hex');

      const existing = this.db.prepare('SELECT hash FROM files WHERE path = ?').get(file.path) as { hash: string } | undefined;
      if (existing?.hash === hash) {
        existingPaths.delete(file.path);
        continue;
      }

      // Remove old chunks for this file
      this.removeFileChunks(file.path);

      // Chunk and insert
      const maxChars = this.cfg.chunkTokens * 4;
      const overlapChars = this.cfg.chunkOverlap * 4;
      const chunks = chunkMarkdown(content, maxChars, overlapChars);

      const insertChunk = this.db.prepare(
        'INSERT OR REPLACE INTO chunks (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      );
      const insertFts = this.db.prepare(
        'INSERT INTO chunks_fts (text, id, path, source, start_line, end_line) VALUES (?, ?, ?, ?, ?, ?)'
      );

      const insertMany = this.db.transaction(() => {
        for (const chunk of chunks) {
          const id = crypto.randomUUID();
          insertChunk.run(id, file.path, file.source, chunk.startLine, chunk.endLine, chunk.hash, '', chunk.text, '[]', Date.now());
          insertFts.run(chunk.text, id, file.path, file.source, chunk.startLine, chunk.endLine);
        }
      });
      insertMany();

      // Update file record
      const stat = fs.statSync(path.join(this.workspace, file.path));
      this.db.prepare('INSERT OR REPLACE INTO files (path, source, hash, mtime, size) VALUES (?, ?, ?, ?, ?)')
        .run(file.path, file.source, hash, stat.mtimeMs, stat.size);

      indexed += chunks.length;
      existingPaths.delete(file.path);
    }

    // Remove deleted files
    for (const oldPath of existingPaths) {
      this.removeFileChunks(oldPath);
      this.db.prepare('DELETE FROM files WHERE path = ?').run(oldPath);
      removed++;
    }

    // Generate embeddings for new chunks (if enabled)
    if (this.cfg.vectorEnabled && this.cfg.embeddingApiKey) {
      embedded = await this.embedUnembeddedChunks();
    }

    return { indexed, removed, embedded };
  }

  private discoverFiles(): Array<{ path: string; source: 'memory' | 'sessions' }> {
    const files: Array<{ path: string; source: 'memory' | 'sessions' }> = [];

    // MEMORY.md at workspace root
    if (fs.existsSync(path.join(this.workspace, 'MEMORY.md'))) {
      files.push({ path: 'MEMORY.md', source: 'memory' });
    }

    // memory/*.md directory
    const memDir = path.join(this.workspace, 'memory');
    if (fs.existsSync(memDir)) {
      for (const f of fs.readdirSync(memDir)) {
        if (f.endsWith('.md')) {
          files.push({ path: `memory/${f}`, source: 'memory' });
        }
      }
    }

    // Session transcripts (optional)
    if (this.cfg.indexSessions) {
      const sessDir = path.join(this.workspace, 'sessions');
      if (fs.existsSync(sessDir)) {
        for (const f of fs.readdirSync(sessDir)) {
          if (f.endsWith('.jsonl') || f.endsWith('.md')) {
            files.push({ path: `sessions/${f}`, source: 'sessions' });
          }
        }
      }
    }

    return files;
  }

  private removeFileChunks(filePath: string): void {
    const chunkIds = (this.db.prepare('SELECT id FROM chunks WHERE path = ?').all(filePath) as Array<{ id: string }>).map(r => r.id);
    if (chunkIds.length === 0) return;

    this.db.prepare('DELETE FROM chunks WHERE path = ?').run(filePath);
    for (const id of chunkIds) {
      this.db.prepare('DELETE FROM chunks_fts WHERE id = ?').run(id);
      if (this.hasVecExtension) {
        try { this.db.prepare('DELETE FROM chunks_vec WHERE id = ?').run(id); } catch { /* ignore if table doesn't exist */ }
      }
    }
  }

  private async embedUnembeddedChunks(): Promise<number> {
    const unembedded = this.db.prepare(
      "SELECT id, text, hash FROM chunks WHERE model = '' OR embedding = '[]' LIMIT 100"
    ).all() as Array<{ id: string; text: string; hash: string }>;

    if (unembedded.length === 0) return 0;

    // Check cache first
    const toEmbed: Array<{ id: string; text: string; hash: string }> = [];
    const fromCache: Array<{ id: string; embedding: number[] }> = [];

    for (const chunk of unembedded) {
      const cached = this.db.prepare(
        'SELECT embedding FROM embedding_cache WHERE model = ? AND hash = ?'
      ).get(this.cfg.embeddingModel, chunk.hash) as { embedding: string } | undefined;

      if (cached) {
        fromCache.push({ id: chunk.id, embedding: JSON.parse(cached.embedding) });
      } else {
        toEmbed.push(chunk);
      }
    }

    // Apply cached embeddings
    for (const { id, embedding } of fromCache) {
      this.applyEmbedding(id, embedding);
    }

    // Embed new chunks in batches
    let embedded = fromCache.length;
    const batchSize = 50;
    for (let i = 0; i < toEmbed.length; i += batchSize) {
      const batch = toEmbed.slice(i, i + batchSize);
      try {
        const embeddings = await embedTexts(
          batch.map(c => c.text),
          this.cfg.embeddingApiKey,
          this.cfg.embeddingModel,
          this.cfg.embeddingDimensions,
        );

        for (let j = 0; j < batch.length; j++) {
          const chunk = batch[j]!;
          const embedding = embeddings[j]!;

          this.applyEmbedding(chunk.id, embedding);

          // Cache
          this.db.prepare(
            'INSERT OR REPLACE INTO embedding_cache (model, hash, embedding, dims, updated_at) VALUES (?, ?, ?, ?, ?)'
          ).run(this.cfg.embeddingModel, chunk.hash, JSON.stringify(embedding), embedding.length, Date.now());

          embedded++;
        }
      } catch (err) {
        console.error(`[memory-index] Embedding batch failed: ${(err as Error).message}`);
        break;
      }
    }

    return embedded;
  }

  private applyEmbedding(chunkId: string, embedding: number[]): void {
    this.db.prepare('UPDATE chunks SET embedding = ?, model = ? WHERE id = ?')
      .run(JSON.stringify(embedding), this.cfg.embeddingModel, chunkId);

    if (this.hasVecExtension) {
      try {
        const blob = Buffer.from(new Float32Array(embedding).buffer);
        this.db.prepare('INSERT OR REPLACE INTO chunks_vec (id, embedding) VALUES (?, ?)').run(chunkId, blob);
      } catch { /* vec table may not exist */ }
    }
  }

  // ── Search ──

  async search(query: string, maxResults = 6, minScore = 0.1): Promise<MemorySearchResult[]> {
    // Sync before searching (ensures latest file changes are indexed)
    await this.sync();

    const candidateMultiplier = 4;
    const fetchLimit = maxResults * candidateMultiplier;

    // Keyword search (FTS5)
    const keywordResults = this.searchKeyword(query, fetchLimit);

    // Vector search (if enabled and available)
    let vectorResults: Array<{ id: string; path: string; startLine: number; endLine: number; snippet: string; source: string; score: number }> = [];
    if (this.cfg.vectorEnabled && this.cfg.embeddingApiKey) {
      try {
        vectorResults = await this.searchVector(query, fetchLimit);
      } catch {
        // Embedding API failed — fall back to keyword-only
      }
    }

    // Hybrid merge
    const merged = this.mergeResults(keywordResults, vectorResults);

    // Apply temporal decay
    const decayed = this.cfg.temporalDecay
      ? this.applyTemporalDecay(merged)
      : merged;

    // Sort by score
    decayed.sort((a, b) => b.score - a.score);

    // Filter by minimum score
    const filtered = decayed.filter(r => r.score >= minScore);

    // Apply MMR if enabled
    const final = this.cfg.mmrEnabled
      ? mmrRerank(filtered, this.cfg.mmrLambda).slice(0, maxResults)
      : filtered.slice(0, maxResults);

    return final;
  }

  private searchKeyword(query: string, limit: number): MemorySearchResult[] {
    const ftsQuery = buildFtsQuery(query);
    if (!ftsQuery) return [];

    try {
      const rows = this.db.prepare(`
        SELECT id, path, source, start_line, end_line, text, bm25(chunks_fts) AS rank
          FROM chunks_fts
         WHERE chunks_fts MATCH ?
         ORDER BY rank ASC
         LIMIT ?
      `).all(ftsQuery, limit) as Array<{
        id: string; path: string; source: string; start_line: number; end_line: number; text: string; rank: number;
      }>;

      return rows.map(r => ({
        path: r.path,
        startLine: r.start_line,
        endLine: r.end_line,
        score: bm25RankToScore(r.rank),
        snippet: r.text.slice(0, 700),
        source: r.source as 'memory' | 'sessions',
      }));
    } catch {
      return [];
    }
  }

  private async searchVector(query: string, limit: number): Promise<MemorySearchResult[]> {
    // Embed the query
    const [queryVec] = await embedTexts(
      [query],
      this.cfg.embeddingApiKey,
      this.cfg.embeddingModel,
      this.cfg.embeddingDimensions,
    );
    if (!queryVec) return [];

    if (this.hasVecExtension) {
      // Use sqlite-vec native search
      try {
        const blob = Buffer.from(new Float32Array(queryVec).buffer);
        const rows = this.db.prepare(`
          SELECT c.id, c.path, c.start_line, c.end_line, c.text, c.source,
                 vec_distance_cosine(v.embedding, ?) AS dist
            FROM chunks_vec v
            JOIN chunks c ON c.id = v.id
           ORDER BY dist ASC
           LIMIT ?
        `).all(blob, limit) as Array<{
          id: string; path: string; start_line: number; end_line: number; text: string; source: string; dist: number;
        }>;

        return rows.map(r => ({
          path: r.path,
          startLine: r.start_line,
          endLine: r.end_line,
          score: 1 - r.dist,
          snippet: r.text.slice(0, 700),
          source: r.source as 'memory' | 'sessions',
        }));
      } catch {
        // Fall through to in-memory cosine
      }
    }

    // Fallback: in-memory cosine similarity (slower but works without sqlite-vec)
    const allChunks = this.db.prepare(
      "SELECT id, path, source, start_line, end_line, text, embedding FROM chunks WHERE model != '' AND embedding != '[]'"
    ).all() as Array<{
      id: string; path: string; source: string; start_line: number; end_line: number; text: string; embedding: string;
    }>;

    const scored = allChunks.map(c => {
      const emb = JSON.parse(c.embedding) as number[];
      return {
        path: c.path,
        startLine: c.start_line,
        endLine: c.end_line,
        score: cosineSimilarity(queryVec, emb),
        snippet: c.text.slice(0, 700),
        source: c.source as 'memory' | 'sessions',
      };
    }).sort((a, b) => b.score - a.score).slice(0, limit);

    return scored;
  }

  private mergeResults(
    keyword: MemorySearchResult[],
    vector: MemorySearchResult[],
  ): MemorySearchResult[] {
    // If only one source, return it directly
    if (vector.length === 0) return keyword.map(r => ({ ...r }));
    if (keyword.length === 0) return vector.map(r => ({ ...r }));

    // Merge by path+startLine key
    const byKey = new Map<string, { vectorScore: number; textScore: number } & Omit<MemorySearchResult, 'score'>>();

    for (const r of vector) {
      const key = `${r.path}:${r.startLine}`;
      byKey.set(key, { ...r, vectorScore: r.score, textScore: 0 });
    }

    for (const r of keyword) {
      const key = `${r.path}:${r.startLine}`;
      const existing = byKey.get(key);
      if (existing) {
        existing.textScore = r.score;
      } else {
        byKey.set(key, { ...r, vectorScore: 0, textScore: r.score });
      }
    }

    return Array.from(byKey.values()).map(entry => ({
      path: entry.path,
      startLine: entry.startLine,
      endLine: entry.endLine,
      score: this.cfg.vectorWeight * (entry as any).vectorScore + this.cfg.textWeight * (entry as any).textScore,
      snippet: entry.snippet,
      source: entry.source,
    }));
  }

  private applyTemporalDecay(results: MemorySearchResult[]): MemorySearchResult[] {
    const now = Date.now();
    return results.map(r => {
      // Extract date from path: memory/YYYY-MM-DD.md
      const dateMatch = r.path.match(/(\d{4})-(\d{2})-(\d{2})\.md$/);
      if (!dateMatch) return r; // Evergreen memory — no decay

      const fileDate = new Date(`${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}`);
      const ageInDays = (now - fileDate.getTime()) / (24 * 60 * 60 * 1000);
      const multiplier = temporalDecayMultiplier(ageInDays, this.cfg.halfLifeDays);

      return { ...r, score: r.score * multiplier };
    });
  }

  // ── Stats ──

  stats(): { files: number; chunks: number; embedded: number; hasVec: boolean } {
    const files = (this.db.prepare('SELECT COUNT(*) as c FROM files').get() as { c: number }).c;
    const chunks = (this.db.prepare('SELECT COUNT(*) as c FROM chunks').get() as { c: number }).c;
    const embedded = (this.db.prepare("SELECT COUNT(*) as c FROM chunks WHERE model != '' AND embedding != '[]'").get() as { c: number }).c;
    return { files, chunks, embedded, hasVec: this.hasVecExtension };
  }

  close(): void {
    this.db.close();
  }
}

// ── Consolidation helper ──

/**
 * Consolidate recent session activity into explicit memory entries.
 * Reads session-log.md (from pre-compaction flush) and distills into MEMORY.md.
 */
export async function consolidateMemory(workspace: string): Promise<number> {
  const sessionLog = path.join(workspace, 'memory', 'session-log.md');
  const memoryFile = path.join(workspace, 'MEMORY.md');

  if (!fs.existsSync(sessionLog)) return 0;

  const content = fs.readFileSync(sessionLog, 'utf-8');
  if (content.trim().length < 20) return 0;

  // Extract bullet points from session log
  const facts = content.match(/^- .+$/gm) ?? [];
  if (facts.length === 0) return 0;

  // Deduplicate against existing MEMORY.md
  const existing = fs.existsSync(memoryFile) ? fs.readFileSync(memoryFile, 'utf-8').toLowerCase() : '';
  const newFacts = facts.filter(f => {
    const keywords = f.toLowerCase().split(/\s+/).filter(w => w.length > 5).slice(0, 3);
    return !keywords.every(kw => existing.includes(kw));
  });

  if (newFacts.length === 0) return 0;

  // Append to MEMORY.md
  const header = `\n§\n`;
  const section = newFacts.map(f => f.replace(/^- /, '')).join('\n§\n');
  fs.appendFileSync(memoryFile, header + section + '\n');

  // Clear session log (already consolidated)
  fs.writeFileSync(sessionLog, '');

  return newFacts.length;
}
