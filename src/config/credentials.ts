/**
 * Persistent credential store at ~/.shizuha/credentials.json
 *
 * Auto-persist: tokens discovered from transient sources (env vars, Claude CLI files)
 * are automatically saved so they survive across terminals. Run shizuha once with
 * CLAUDE_CODE_OAUTH_TOKEN set → token persists forever → works without the env var.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

// ── Types ──

export interface AnthropicTokenEntry {
  token: string;
  label: string;
  addedAt: string;
}

export interface ProviderTokens {
  tokens: AnthropicTokenEntry[];
}

export interface CodexAccountEntry {
  email: string;
  accessToken: string;
  refreshToken: string;
  idToken?: string;
  accountId: string;
  addedAt: string;
  lastRefresh?: string;
}

export interface CopilotCredential {
  githubToken: string;
  label?: string;
  addedAt: string;
}

export interface CredentialStore {
  anthropic?: ProviderTokens;
  openai?: { apiKey: string };
  google?: { apiKey: string };
  codex?: { accounts: CodexAccountEntry[] };
  copilot?: CopilotCredential;
}

// ── Paths ──

export function credentialsDir(): string {
  return path.join(process.env['HOME'] ?? '~', '.shizuha');
}

export function credentialsPath(): string {
  return path.join(credentialsDir(), 'credentials.json');
}

// ── Read / Write ──

/** Read credential store (user-managed tokens only). */
export function readCredentials(): CredentialStore {
  try {
    const raw = fs.readFileSync(credentialsPath(), 'utf-8');
    return JSON.parse(raw) as CredentialStore;
  } catch {
    // File doesn't exist or is invalid — return empty store
    return {};
  }
}

/**
 * Discover ALL Claude OAuth tokens from all sources.
 * Returns a deduplicated pool for random-pick + 401-failover.
 *
 * Auto-persist: tokens found from transient sources (env vars, Claude CLI files)
 * are automatically saved to ~/.shizuha/credentials.json so they survive across
 * terminals/sessions. This means: run shizuha once with CLAUDE_CODE_OAUTH_TOKEN
 * set → token is saved permanently → works in all future terminals without env var.
 *
 * Sources (all additive, not priority-ordered):
 * 1. CLAUDE_CODE_OAUTH_TOKEN env var
 * 2. CLAUDE_ACCOUNTS_JSON env var (all entries)
 * 3. ~/.shizuha/credentials.json → anthropic.tokens (user-managed)
 * 4. ~/.claude/.credentials.json → claudeAiOauth.accessToken
 * 5. ~/.claude/accounts/*.json files
 */
export function discoverClaudeTokens(): AnthropicTokenEntry[] {
  const seen = new Set<string>();
  const tokens: AnthropicTokenEntry[] = [];

  const add = (token: string, label: string) => {
    if (!token || seen.has(token)) return;
    seen.add(token);
    tokens.push({ token, label, addedAt: '' });
  };

  // 3. ~/.shizuha/credentials.json → anthropic.tokens (read FIRST to know what's persisted)
  const persistedTokens = new Set<string>();
  try {
    const creds = readCredentials();
    for (const t of creds.anthropic?.tokens ?? []) {
      persistedTokens.add(t.token);
      add(t.token, t.label);
    }
  } catch { /* ignore */ }

  // Track tokens from transient sources for auto-persist
  const transientTokens: Array<{ token: string; label: string }> = [];

  // 1. CLAUDE_CODE_OAUTH_TOKEN env var
  const envToken = process.env['CLAUDE_CODE_OAUTH_TOKEN'];
  if (envToken) {
    add(envToken, 'env-primary');
    if (!persistedTokens.has(envToken)) transientTokens.push({ token: envToken, label: 'env-primary' });
  }

  // 2. CLAUDE_ACCOUNTS_JSON env var
  const envJson = process.env['CLAUDE_ACCOUNTS_JSON'];
  if (envJson) {
    try {
      const parsed = JSON.parse(envJson) as Array<{ token: string; label?: string }>;
      for (let i = 0; i < parsed.length; i++) {
        const entry = parsed[i];
        if (entry?.token) {
          const label = entry.label ?? `accounts_${i}`;
          add(entry.token, label);
          if (!persistedTokens.has(entry.token)) transientTokens.push({ token: entry.token, label });
        }
      }
    } catch { /* ignore */ }
  }

  // 4. ~/.claude/.credentials.json → claudeAiOauth.accessToken
  // Used by the daemon to inject tokens into agent containers running Claude Code CLI.
  // The OAuth *provider* is in a separate plugin (provider-claude-code), but the daemon
  // still needs token discovery to pass credentials to claude-bridge containers.
  try {
    const credPath = path.join(process.env['HOME'] ?? '~', '.claude', '.credentials.json');
    const raw = fs.readFileSync(credPath, 'utf-8');
    const data = JSON.parse(raw) as Record<string, unknown>;
    const oauth = data['claudeAiOauth'] as Record<string, unknown> | undefined;
    const token = oauth?.['accessToken'] as string | undefined;
    if (token && token.length > 20) {
      add(token, 'claude-cli');
      if (!persistedTokens.has(token)) transientTokens.push({ token, label: 'claude-cli' });
    }
  } catch { /* ignore */ }

  // 5. ~/.claude/accounts/*.json
  try {
    const accountsDir = path.join(process.env['HOME'] ?? '~', '.claude', 'accounts');
    const files = fs.readdirSync(accountsDir).filter((f: string) => f.endsWith('.json')).sort();
    for (const file of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(accountsDir, file), 'utf-8'));
        if (data.token) {
          const label = data.label ?? file.replace('.json', '');
          add(data.token, label);
          if (!persistedTokens.has(data.token)) transientTokens.push({ token: data.token, label });
        }
      } catch { /* skip */ }
    }
  } catch { /* ignore */ }

  // Auto-persist: save transient tokens to credential store so they survive across terminals
  if (transientTokens.length > 0) {
    try {
      const store = readCredentials();
      if (!store.anthropic) store.anthropic = { tokens: [] };
      const existingTokens = new Set(store.anthropic.tokens.map((t) => t.token));
      let added = 0;
      for (const t of transientTokens) {
        if (!existingTokens.has(t.token)) {
          store.anthropic.tokens.push({ token: t.token, label: t.label, addedAt: new Date().toISOString() });
          added++;
        }
      }
      if (added > 0) {
        writeCredentials(store);
      }
    } catch { /* ignore — don't let persist failures block discovery */ }
  }

  return tokens;
}

/** Atomic write with restricted permissions. */
export function writeCredentials(store: CredentialStore): void {
  const dir = credentialsDir();
  // Ensure directory exists with mode 700
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  const filePath = credentialsPath();
  const tmpPath = filePath + '.tmp';

  fs.writeFileSync(tmpPath, JSON.stringify(store, null, 2), { mode: 0o600 });
  fs.renameSync(tmpPath, filePath);
}

// ── Anthropic Token Management ──

/** Append a token to the anthropic.tokens array. */
export function addAnthropicToken(token: string, label?: string): void {
  const store = readCredentials();
  if (!store.anthropic) {
    store.anthropic = { tokens: [] };
  }

  const finalLabel = label ?? `token_${store.anthropic.tokens.length + 1}`;
  store.anthropic.tokens.push({
    token,
    label: finalLabel,
    addedAt: new Date().toISOString(),
  });

  writeCredentials(store);
}

/** Remove a token by label. */
export function removeAnthropicToken(label: string): boolean {
  const store = readCredentials();
  if (!store.anthropic?.tokens?.length) return false;

  const before = store.anthropic.tokens.length;
  store.anthropic.tokens = store.anthropic.tokens.filter((t) => t.label !== label);

  if (store.anthropic.tokens.length === before) return false;
  writeCredentials(store);
  return true;
}

// ── OpenAI / Google Key Management ──

export function setOpenAIKey(key: string): void {
  const store = readCredentials();
  store.openai = { apiKey: key };
  writeCredentials(store);
}

export function setGoogleKey(key: string): void {
  const store = readCredentials();
  store.google = { apiKey: key };
  writeCredentials(store);
}

export function removeProvider(provider: 'anthropic' | 'openai' | 'google'): boolean {
  const store = readCredentials();
  if (!store[provider]) return false;
  delete store[provider];
  writeCredentials(store);
  return true;
}

// ── Codex Account Management ──

/** Read all Codex accounts from the credential store. */
export function readCodexAccounts(): CodexAccountEntry[] {
  const store = readCredentials();
  return store.codex?.accounts ?? [];
}

/** Add or update a Codex account in the credential store. */
export function saveCodexAccount(entry: CodexAccountEntry): void {
  const store = readCredentials();
  if (!store.codex) store.codex = { accounts: [] };
  // Replace if same email exists, otherwise append
  const idx = store.codex.accounts.findIndex((a) => a.email === entry.email);
  if (idx >= 0) {
    store.codex.accounts[idx] = entry;
  } else {
    store.codex.accounts.push(entry);
  }
  writeCredentials(store);
}

/** Update tokens for an existing Codex account (after refresh). */
export function updateCodexTokens(email: string, accessToken: string, refreshToken?: string, idToken?: string): void {
  const store = readCredentials();
  if (!store.codex?.accounts) return;
  const account = store.codex.accounts.find((a) => a.email === email);
  if (!account) return;
  account.accessToken = accessToken;
  if (refreshToken) account.refreshToken = refreshToken;
  if (idToken) account.idToken = idToken;
  account.lastRefresh = new Date().toISOString();
  writeCredentials(store);
}

/** Remove a Codex account by email. */
export function removeCodexAccount(email: string): boolean {
  const store = readCredentials();
  if (!store.codex?.accounts?.length) return false;
  const before = store.codex.accounts.length;
  store.codex.accounts = store.codex.accounts.filter((a) => a.email !== email);
  if (store.codex.accounts.length === before) return false;
  writeCredentials(store);
  return true;
}

/** Reorder Codex accounts. `emails` must contain exactly the same set of emails. */
export function reorderCodexAccounts(emails: string[]): boolean {
  const store = readCredentials();
  if (!store.codex?.accounts?.length) return false;
  const existing = store.codex.accounts;
  if (emails.length !== existing.length) return false;

  const byEmail = new Map(existing.map((a) => [a.email, a]));
  const reordered: CodexAccountEntry[] = [];
  for (const email of emails) {
    const entry = byEmail.get(email);
    if (!entry) return false; // unknown email
    reordered.push(entry);
  }

  store.codex.accounts = reordered;
  writeCredentials(store);
  return true;
}

// ── GitHub Copilot Credential Management ──

/** Read GitHub Copilot credential. */
export function readCopilotCredential(): CopilotCredential | undefined {
  const store = readCredentials();
  return store.copilot;
}

/** Set GitHub Copilot credential (GitHub PAT with Copilot scope). */
export function setCopilotToken(githubToken: string, label?: string): void {
  const store = readCredentials();
  store.copilot = {
    githubToken,
    label,
    addedAt: new Date().toISOString(),
  };
  writeCredentials(store);
}

/** Remove GitHub Copilot credential. */
export function removeCopilotToken(): boolean {
  const store = readCredentials();
  if (!store.copilot) return false;
  delete store.copilot;
  writeCredentials(store);
  return true;
}

