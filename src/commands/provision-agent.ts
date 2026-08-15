/**
 * SCLI-65: provision-agent command
 *
 * Onboards a new agent by:
 *   1. Provisioning a shizuha-id user account (register → approve → set-password → login).
 *   2. Writing a scoped `.mcp.json` to the agent's Claude home dir, based on the
 *      role's access-matrix (SCLI-44/mcp-access-matrix.ts).
 *   3. Seeding per-service OAuth credentials into `.credentials.json` so Claude Code's
 *      native MCP OAuth provider handles token refresh without a static bearer header.
 *
 * Usage:
 *   shizuha provision-agent <username> [options]
 *
 * Options:
 *   --role <role>           Agent role (default: engineer)
 *   --home <path>           Agent home directory (default: /home/<username>)
 *   --platform-url <url>    Platform base URL (default: SHIZUHA_PLATFORM_URL env)
 *   --admin-token <token>   Admin token for account approval (default: SHIZUHA_ADMIN_TOKEN env)
 *   --oauth-services <list> Comma-separated services to seed OAuth for, or '*' (default: SHIZUHA_MCP_OAUTH_SERVICES env)
 *   --first-name <name>     Agent display first name (default: capitalized username)
 *   --last-name <name>      Agent display last name (default: '(AI Agent)')
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ensureAgentAccount } from '../daemon/agent-accounts.js';
import { resolveAllowedServers } from '../platform/mcp-access-matrix.js';
import { getPlatformMcpConfigs, PLATFORM_MCP_SERVICES } from '../platform/mcp-services.js';
import { seedMcpOAuthCredentials, oauthServiceMatcher } from '../platform/mcp-oauth-seed.js';

// SCLI-436: the DOCUMENTED closed role enum for provision-agent (mirrors the
// --role help string). A role must be exactly one of these, case-sensitive.
export const PROVISION_AGENT_ROLES = [
  'reviewer',
  'architect',
  'engineer',
  'qa',
  'security',
  'docs',
  'analytics',
  'devops',
  'social',
] as const;
export type ProvisionAgentRole = (typeof PROVISION_AGENT_ROLES)[number];

// Canonical account identifier grammar: alphanumeric first char, then
// alphanumerics / '.' / '-' / '_' only. Rejects empty, whitespace (incl. TAB/LF),
// control bytes (incl. ANSI ESC), and any path/parent-traversal syntax (SCLI-436).
export const PROVISION_USERNAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const NAME_RE = /^[^\u0000-\u001f\u007f]*$/;

/**
 * Render a user-supplied value inside a diagnostic so it can never leak raw
 * bytes into an operator-facing terminal: control characters and line breaks
 * are printed as JSON escapes (single line), and the value is length-capped.
 */
export function describeProvisionValue(value: string, max = 80): string {
  const json = JSON.stringify(value);
  if (json.length <= max + 2) return json;
  return `${json.slice(0, max)}…`;
}

export interface ProvisionPreflight {
  role: string;
  platformUrl: string;
  adminToken: string;
}

/**
 * SCLI-436 semantic preflight — runs BEFORE any registration/network call, any
 * startup/provisioning copy, or any HOME/target state write. Throws ONE concise,
 * escaped, actionable diagnostic for the first invalid value; the caller prints
 * it and exits nonzero with zero state mutation (no `.shizuha/agent-auth/`).
 */
export function validateProvisionInputs(
  agentUsername: string,
  opts: ProvisionAgentOptions,
): ProvisionPreflight {
  // Username: nonblank canonical account identifier, no whitespace/control/path syntax.
  if (!agentUsername) {
    throw new Error('provision-agent: username must be non-empty');
  }
  if (CONTROL_RE.test(agentUsername) || /\s/.test(agentUsername)) {
    throw new Error(
      `provision-agent: username must not contain whitespace or control characters ` +
        `(got ${describeProvisionValue(agentUsername)})`,
    );
  }
  if (!PROVISION_USERNAME_RE.test(agentUsername)) {
    throw new Error(
      `provision-agent: username must be a canonical identifier (letters/digits/._- only, ` +
        `no path syntax or '..') (got ${describeProvisionValue(agentUsername)})`,
    );
  }

  // Role: exactly one documented enum value; explicit empty never silently defaults.
  const role = opts.role ?? 'engineer';
  if (!PROVISION_AGENT_ROLES.includes(role as ProvisionAgentRole)) {
    const emptyNote = role === ''
      ? ' (an empty role is invalid — pass an explicit documented role)'
      : '';
    throw new Error(
      `provision-agent: role must be one of ${PROVISION_AGENT_ROLES.join('|')} ` +
        `(got ${describeProvisionValue(role)})${emptyNote}`,
    );
  }

  // Platform URL: an absolute http:// or https:// URL only (no file:, javascript:,
  // relative paths, or scheme-less inputs).
  const platformUrl = (opts.platformUrl || process.env['SHIZUHA_PLATFORM_URL'] || '').trim();
  if (!platformUrl) {
    throw new Error('provision-agent: platform URL required — pass --platform-url or set SHIZUHA_PLATFORM_URL');
  }
  let parsed: URL;
  try {
    parsed = new URL(platformUrl);
  } catch {
    throw new Error(
      `provision-agent: platform URL must be an absolute URL (got ${describeProvisionValue(platformUrl)})`,
    );
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(
      `provision-agent: platform URL must use http:// or https:// (got ${describeProvisionValue(platformUrl)})`,
    );
  }
  if (!parsed.hostname) {
    throw new Error(
      `provision-agent: platform URL must include a host (got ${describeProvisionValue(platformUrl)})`,
    );
  }

  // Admin token: required — validated preflight so failure precedes any state write.
  const adminToken = opts.adminToken || process.env['SHIZUHA_ADMIN_TOKEN'] || '';
  if (!adminToken) {
    throw new Error('provision-agent: admin token required — pass --admin-token or set SHIZUHA_ADMIN_TOKEN');
  }

  // Display names: keep control/line-feed bytes out of registration and reflection too.
  for (const [field, value] of [
    ['first-name', opts.firstName],
    ['last-name', opts.lastName],
  ] as const) {
    if (value !== undefined && !NAME_RE.test(value)) {
      throw new Error(
        `provision-agent: ${field} must not contain control characters (got ${describeProvisionValue(value)})`,
      );
    }
  }

  return { role, platformUrl, adminToken };
}

/**
 * Return the Unix UID for a username by parsing /etc/passwd.
 * Returns -1 (no change) when the user isn't found or the file can't be read.
 */
function resolveUnixUid(username: string): number {
  try {
    const lines = fs.readFileSync('/etc/passwd', 'utf-8').split('\n');
    for (const line of lines) {
      const parts = line.split(':');
      if (parts[0] === username && parts.length >= 4) {
        const uid = parseInt(parts[2]!, 10);
        if (!Number.isNaN(uid)) return uid;
      }
    }
  } catch { /* /etc/passwd unreadable — best-effort */ }
  return -1;
}

/**
 * Build MCP server configs for non-platform (stdio) servers present in allowList
 * that are NOT in PLATFORM_MCP_SERVICES (which only covers HTTP endpoints).
 * shizuha-cron used to live here; it is decommissioned. Local capabilities now
 * live in native SCLI tools or dedicated platform MCP services.
 */
function getNonPlatformMcpConfigs(
  allowList: string[],
  agentUsername: string,
): Record<string, unknown> {
  const platformNames = new Set(PLATFORM_MCP_SERVICES.map(s => s.name));
  void allowList.filter(n => !platformNames.has(n));
  void agentUsername;
  return {};
}

export interface ProvisionAgentOptions {
  role?: string;
  home?: string;
  platformUrl?: string;
  adminToken?: string;
  oauthServices?: string;
  firstName?: string;
  lastName?: string;
}

export interface ProvisionAgentResult {
  username: string;
  userId: number;
  email: string;
  homeDir: string;
  mcpJsonPath: string;
  allowedServers: string[];
  oauthSeeded: string[];
  alreadyExisted: boolean;
}

export async function runProvisionAgent(
  agentUsername: string,
  opts: ProvisionAgentOptions,
): Promise<ProvisionAgentResult> {
  // SCLI-436: semantic preflight BEFORE any startup/provisioning copy, network
  // call, or HOME/target state write. Invalid username/role/URL/admin/names
  // throw here with ONE escaped diagnostic — nothing is printed, registered,
  // or written (no `.shizuha/agent-auth/` is created on invalid input).
  const { role, platformUrl, adminToken } = validateProvisionInputs(agentUsername, opts);

  const homeDir = opts.home || path.join('/home', agentUsername);
  const claudeDir = path.join(homeDir, '.claude');

  console.log(`[provision-agent] Provisioning '${agentUsername}' (role=${role})…`);

  // Step 1: Ensure shizuha-id account exists and we have a valid access token.
  const provision = await ensureAgentAccount({
    agentUsername,
    agentEmail: `${agentUsername}@agents.shizuha.io`,
    agentFirstName: opts.firstName,
    agentLastName: opts.lastName,
    platformUrl,
    adminToken,
  });

  if (!provision) {
    throw new Error(`Failed to provision shizuha-id account for '${agentUsername}'`);
  }

  console.log(`[provision-agent] Account ready: userId=${provision.userId} email=${provision.email}`);

  // Load stored credentials to retrieve the password (needed for OAuth seed).
  const credFile = path.join(
    process.env['HOME'] ?? os.homedir(),
    '.shizuha',
    'agent-auth',
    `${agentUsername}.json`,
  );
  let agentPassword = '';
  try {
    if (fs.existsSync(credFile)) {
      const creds = JSON.parse(fs.readFileSync(credFile, 'utf-8')) as { password?: string };
      agentPassword = creds.password ?? '';
    }
  } catch { /* unable to read password; OAuth seed will be skipped */ }

  // Step 2: Resolve the allowed MCP server set for this role.
  const allowedSet = resolveAllowedServers(role, agentUsername);
  const allowList = [...allowedSet];

  console.log(`[provision-agent] MCP allow-list (${allowList.length}): ${allowList.join(', ')}`);

  // Step 3: Build the mcpServers config map (scoped to allow-list).
  // getPlatformMcpConfigs covers HTTP platform services (McpEntry-typed, needed for
  // OAuth seed). Non-platform stdio entries are intentionally empty now; local
  // capabilities live in native SCLI tools or dedicated platform MCP services.
  const platformMcpServers = getPlatformMcpConfigs({
    bearerToken: provision.accessToken,
    platformUrl,
    allowList,
  });
  const nonPlatformMcpServers = getNonPlatformMcpConfigs(allowList, agentUsername);

  // P1: loader.ts searches cwd/.mcp.json then HOME/.mcp.json; writing to
  // .claude/.mcp.json is never loaded. Write to HOME/.mcp.json instead.
  fs.mkdirSync(homeDir, { recursive: true });
  const mcpJsonPath = path.join(homeDir, '.mcp.json');
  let existingMcp: Record<string, unknown> = {};
  try {
    if (fs.existsSync(mcpJsonPath)) {
      existingMcp = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf-8'));
    }
  } catch { /* start fresh */ }
  // P1: prune stale shizuha-* entries — removed servers must not survive as dead credentials.
  const existingNonPlatform = Object.fromEntries(
    Object.entries((existingMcp.mcpServers as Record<string, unknown>) ?? {}).filter(
      ([key]) => !key.startsWith('shizuha-'),
    ),
  );

  // Step 5: Seed per-service OAuth credentials so Claude Code's native refresh works.
  // Run BEFORE writing .mcp.json — seedMcpOAuthCredentials mutates platformMcpServers
  // entries in-place (strips Authorization header for OAuth services); the file must
  // reflect the post-seed state so the OAuth provider engages. Only HTTP (platform)
  // entries are seeded; stdio (non-platform) entries don't use OAuth. (SCLI-65)
  const oauthRaw = opts.oauthServices ?? process.env['SHIZUHA_MCP_OAUTH_SERVICES'] ?? '';
  const isOAuthService = oauthServiceMatcher(oauthRaw);
  const { seeded } = await seedMcpOAuthCredentials({
    mcpServers: platformMcpServers,
    homeDir,
    agentUsername,
    agentPassword,
    platformBase: platformUrl,
    isOAuthService,
    log: (msg) => console.log(`[provision-agent] ${msg}`),
  });

  // Step 4: Write .mcp.json after OAuth seed so the file has stripped auth headers.
  // Merge platform (HTTP, OAuth-processed) + non-platform (stdio) entries together.
  const merged = {
    ...existingMcp,
    mcpServers: {
      ...existingNonPlatform,
      ...platformMcpServers,
      ...nonPlatformMcpServers,
    },
  };
  const allMcpServers = { ...platformMcpServers, ...nonPlatformMcpServers };
  fs.writeFileSync(mcpJsonPath, JSON.stringify(merged, null, 2), { encoding: 'utf-8' });
  // P2: when provisioned as root, chown to the agent's UNIX uid (from /etc/passwd),
  // not the platform userId — provision.userId is the shizuha-id row pk, which
  // will not match the OS UID and leaves the file unreadable by the agent process.
  const unixUid = resolveUnixUid(agentUsername);
  try { fs.chownSync(mcpJsonPath, unixUid, -1); } catch { /* best-effort */ }
  fs.chmodSync(mcpJsonPath, 0o600);
  console.log(`[provision-agent] Wrote ${Object.keys(allMcpServers).length} MCP entries → ${mcpJsonPath}`);

  if (seeded.length > 0) {
    console.log(`[provision-agent] OAuth seeded for: ${seeded.join(', ')}`);
  } else if (oauthRaw) {
    console.log(`[provision-agent] OAuth seed skipped (no password available or no matching services)`);
  }

  return {
    username: provision.username,
    userId: provision.userId,
    email: provision.email,
    homeDir,
    mcpJsonPath,
    allowedServers: allowList,
    oauthSeeded: seeded,
    alreadyExisted: false,
  };
}

export function printProvisionResult(result: ProvisionAgentResult): void {
  console.log('');
  console.log(`✓ Agent '${result.username}' provisioned`);
  console.log(`  User ID  : ${result.userId}`);
  console.log(`  Email    : ${result.email}`);
  console.log(`  Home     : ${result.homeDir}`);
  console.log(`  MCP conf : ${result.mcpJsonPath}`);
  console.log(`  Servers  : ${result.allowedServers.join(', ')}`);
  if (result.oauthSeeded.length > 0) {
    console.log(`  OAuth    : ${result.oauthSeeded.join(', ')}`);
  }
}
