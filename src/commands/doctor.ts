import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';

export interface DoctorCheck {
  name: string;
  status: 'pass' | 'warn' | 'fail';
  message: string;
  fix?: string;
}

// ANSI color helpers (no chalk dependency)
const RESET = '\x1b[0m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';

function useColor(): boolean {
  if (process.env['NO_COLOR'] !== undefined && process.env['NO_COLOR'] !== '') {
    return false;
  }
  if (process.env['TERM'] === 'dumb') {
    return false;
  }
  return Boolean(process.stdout.isTTY);
}

function col(code: string): string {
  return useColor() ? code : '';
}

function statusIcon(status: 'pass' | 'warn' | 'fail'): string {
  switch (status) {
    case 'pass': return `${col(GREEN)}\u2713${col(RESET)}`;
    case 'warn': return `${col(YELLOW)}\u26A0${col(RESET)}`;
    case 'fail': return `${col(RED)}\u2717${col(RESET)}`;
  }
}

export function printChecks(checks: DoctorCheck[]): void {
  console.log(`\n${col(BOLD)}shizuha doctor${col(RESET)}`);
  console.log('==============\n');

  for (const check of checks) {
    console.log(`${statusIcon(check.status)} ${check.name}: ${check.message}`);
    if (check.fix) {
      console.log(`  ${col(DIM)}Fix: ${check.fix}${col(RESET)}`);
    }
  }

  const passed = checks.filter(c => c.status === 'pass').length;
  const warnings = checks.filter(c => c.status === 'warn').length;
  const failed = checks.filter(c => c.status === 'fail').length;

  console.log(`\nResults: ${col(GREEN)}${passed} passed${col(RESET)}, ${col(YELLOW)}${warnings} warning${warnings !== 1 ? 's' : ''}${col(RESET)}, ${col(RED)}${failed} failed${col(RESET)}`);
}

// --- Individual checks ---

function checkNodeVersion(): DoctorCheck {
  const version = process.version;
  const major = parseInt(version.slice(1).split('.')[0] ?? '0', 10);
  if (major >= 18) {
    return { name: 'Node.js version', status: 'pass', message: `${version} (>= 18 required)` };
  }
  return {
    name: 'Node.js version',
    status: 'fail',
    message: `${version} (>= 18 required)`,
    fix: 'Install Node.js 18+ from https://nodejs.org/',
  };
}

async function checkConfigFile(cwd: string): Promise<DoctorCheck> {
  // Check multiple config layer locations
  const home = process.env['HOME'] ?? os.homedir();
  const candidates = [
    path.join(cwd, '.shizuha', 'config.toml'),
    path.join(cwd, '.shizuha', 'config.local.toml'),
    path.join(home, '.config', 'shizuha', 'config.toml'),
    '/etc/shizuha/config.toml',
  ];

  const found: string[] = [];
  for (const file of candidates) {
    try {
      await fsp.access(file, fs.constants.R_OK);
      found.push(file);
    } catch {
      // not found
    }
  }

  if (found.length === 0) {
    return {
      name: 'Config file',
      status: 'warn',
      message: 'No shizuha config.toml found (using defaults)',
      fix: `Create ${path.join(cwd, '.shizuha', 'config.toml')} or ${path.join(home, '.config', 'shizuha', 'config.toml')}`,
    };
  }

  // Try parsing the first found config
  try {
    const { parse: parseTOML } = await import('smol-toml');
    const content = await fsp.readFile(found[0]!, 'utf-8');
    parseTOML(content);
    return {
      name: 'Config file',
      status: 'pass',
      message: `${found.length} config file${found.length > 1 ? 's' : ''} found and valid`,
    };
  } catch (err) {
    return {
      name: 'Config file',
      status: 'fail',
      message: `Parse error in ${found[0]}: ${(err as Error).message}`,
      fix: 'Check TOML syntax in your config file',
    };
  }
}

function checkApiKey(
  name: string,
  envVar: string,
  required: boolean,
  opts?: { naReason?: string },
): DoctorCheck {
  const value = process.env[envVar];
  if (value) {
    // Mask the key for display
    const masked = value.slice(0, 8) + '...' + value.slice(-4);
    return { name: envVar, status: 'pass', message: `set (${masked})` };
  }
  // SCLI-387: when the active route is authenticated Cortex, missing public
  // vendor keys are not failures — they are simply not required.
  if (opts?.naReason) {
    return {
      name: envVar,
      status: 'pass',
      message: `N/A — ${opts.naReason}`,
    };
  }
  if (required) {
    return {
      name: envVar,
      status: 'fail',
      message: 'not set',
      fix: `export ${envVar}=...`,
    };
  }
  return {
    name: envVar,
    status: 'warn',
    message: 'not set (optional)',
  };
}

function checkApiKeys(opts?: { cortexPrimary?: boolean }): DoctorCheck[] {
  const naReason = opts?.cortexPrimary
    ? 'not required for authenticated Cortex route'
    : undefined;
  const keys: Array<[string, string, boolean]> = [
    ['Anthropic', 'ANTHROPIC_API_KEY', false],
    ['OpenAI', 'OPENAI_API_KEY', false],
    ['Google', 'GOOGLE_API_KEY', false],
  ];

  const checks = keys.map(([name, envVar, required]) =>
    checkApiKey(name, envVar, required, { naReason }),
  );

  // If none are set, make it a warning — unless Cortex is the primary route.
  const anySet = keys.some(([, envVar]) => process.env[envVar]);
  if (!anySet) {
    // Check for codex auth as well
    const home = process.env['HOME'] ?? os.homedir();
    const codexAuthPath = path.join(home, '.shizuha', 'credentials.json');
    let hasCodexAuth = false;
    let hasCortexAuth = false;
    try {
      const creds = JSON.parse(fs.readFileSync(codexAuthPath, 'utf-8'));
      hasCodexAuth = !!(creds.codex?.accessToken || creds.codex?.refreshToken);
      hasCortexAuth = !!(creds.cortex?.apiKey || process.env['CORTEX_API_KEY'] || process.env['CORTEX_BASE_URL']);
    } catch {
      hasCortexAuth = !!(process.env['CORTEX_API_KEY'] || process.env['CORTEX_BASE_URL']);
    }

    if (opts?.cortexPrimary || hasCortexAuth) {
      checks.push({
        name: 'Provider auth',
        status: 'pass',
        message: 'Cortex route configured (public vendor keys not required)',
      });
    } else if (!hasCodexAuth) {
      checks.push({
        name: 'Provider auth',
        status: 'warn',
        message: 'No API keys or Codex auth configured',
        fix: 'Run: shizuha auth codex (free with ChatGPT), or export ANTHROPIC_API_KEY=...',
      });
    } else {
      checks.push({
        name: 'Provider auth',
        status: 'pass',
        message: 'Codex (ChatGPT) auth configured',
      });
    }
  }

  return checks;
}

/**
 * SCLI-387: match a selected model id against a live catalog.
 * Exact match first, then org-prefix / suffix-boundary tolerance.
 * Deliberately does NOT use bare bidirectional substring (rui P2).
 */
export function matchCatalogModelId(selected: string, catalogIds: string[]): string | null {
  const norm = (s: string) => s.toLowerCase().trim();
  const want = norm(selected);
  if (!want) return null;

  // 1) Exact (case-insensitive)
  for (const id of catalogIds) {
    if (norm(id) === want) return id;
  }

  // 2) Org-prefix / path-suffix boundary: "org/model" ↔ "model"
  const wantLeaf = want.includes('/') ? want.slice(want.lastIndexOf('/') + 1) : want;
  for (const id of catalogIds) {
    const n = norm(id);
    const leaf = n.includes('/') ? n.slice(n.lastIndexOf('/') + 1) : n;
    if (leaf === want || leaf === wantLeaf || n === wantLeaf) {
      return id;
    }
    // selected "org/foo" vs catalog "foo" already covered; also catalog "org/foo" vs want "foo"
    if (n.endsWith(`/${want}`) || n.endsWith(`/${wantLeaf}`)) {
      return id;
    }
    if (want.endsWith(`/${n}`) || want.endsWith(`/${leaf}`)) {
      return id;
    }
  }

  return null;
}

async function fetchWithDeadline(
  url: string,
  init: RequestInit,
  label: string,
): Promise<Response> {
  const controller = new AbortController();
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const abortTimer = setTimeout(() => controller.abort(), 8_000);
  try {
    const fetchOnce = fetch(url, { ...init, signal: controller.signal });
    const deadline = new Promise<Response>((_resolve, reject) => {
      deadlineTimer = setTimeout(
        () => reject(new Error(`${label} deadline exceeded (8s)`)),
        8_500,
      );
    });
    return await Promise.race([fetchOnce, deadline]);
  } finally {
    clearTimeout(abortTimer);
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
  }
}

/**
 * Tiny non-billable readiness probe: 1-token chat completion.
 * Distinguishes model_not_found (404/4xx) from busy/transient (429/5xx).
 */
export async function probeModelCompletionReadiness(args: {
  baseUrl: string;
  headers: Record<string, string>;
  modelId: string;
}): Promise<{ status: 'pass' | 'warn' | 'fail'; message: string; fix?: string }> {
  const url = `${args.baseUrl.replace(/\/+$/, '')}/v1/chat/completions`;
  const body = JSON.stringify({
    model: args.modelId,
    messages: [{ role: 'user', content: 'ping' }],
    max_tokens: 1,
    stream: false,
  });

  let res: Response;
  try {
    res = await fetchWithDeadline(
      url,
      {
        method: 'POST',
        headers: {
          ...args.headers,
          'Content-Type': 'application/json',
        },
        body,
      },
      'completion probe',
    );
  } catch (err) {
    return {
      status: 'fail',
      message: `completion probe unreachable (${(err as Error).message})`,
      fix: 'Check CORTEX_BASE_URL / network, then retry /doctor or pick another model',
    };
  }

  if (res.ok) {
    return { status: 'pass', message: 'completion probe ok' };
  }

  const text = await res.text().catch(() => '');
  const snippet = text.slice(0, 160).replace(/\s+/g, ' ');
  const lower = `${text} ${res.statusText}`.toLowerCase();

  if (res.status === 404 || lower.includes('model_not_found') || lower.includes('does not exist')) {
    return {
      status: 'fail',
      message: `completion model_not_found (HTTP ${res.status}${snippet ? ` — ${snippet}` : ''})`,
      fix: 'Model listed in catalog but cannot serve a turn. Choose a currently reachable model with /model',
    };
  }
  if (res.status === 401 || res.status === 403) {
    return {
      status: 'fail',
      message: `completion auth failed (HTTP ${res.status})`,
      fix: 'Re-authenticate (shizuha login / Cortex API key) and retry',
    };
  }
  if (res.status === 429 || res.status >= 500) {
    return {
      status: 'warn',
      message: `reachable but busy/transient (HTTP ${res.status}${snippet ? ` — ${snippet}` : ''})`,
      fix: 'Retry /doctor after Cortex recovers; model route exists but is temporarily unhealthy',
    };
  }
  // Other 4xx — treat as not ready for the selected id
  return {
    status: 'fail',
    message: `completion rejected (HTTP ${res.status}${snippet ? ` — ${snippet}` : ''})`,
    fix: 'Retry /doctor or /model <reachable-id>',
  };
}

/**
 * SCLI-387: probe the selected model on the live provider path.
 * Catalog/route check first, then a bounded tiny completion readiness probe.
 * Surfaces model_not_found distinctly from auth gaps.
 */
export async function checkSelectedModelReachability(
  cwd: string,
  selectedModel?: string,
): Promise<DoctorCheck> {
  const model = (selectedModel || '').trim();
  if (!model) {
    return {
      name: 'Selected model',
      status: 'warn',
      message: 'No model selected in this session',
      fix: 'Pick a model with /model <name>, then re-run /doctor',
    };
  }

  try {
    const { logger, setLogLevel } = await import('../utils/logger.js');
    const prevLevel = logger.level;
    setLogLevel('silent');
    try {
      const { loadConfig } = await import('../config/loader.js');
      const config = await loadConfig(cwd);
      const { ProviderRegistry } = await import('../provider/registry.js');
      const registry = new ProviderRegistry(config);

      let providerName: string;
      let resolvedModel: string;
      try {
        const resolved = registry.resolveWithModel(model);
        providerName = resolved.provider.name;
        resolvedModel = resolved.resolvedModel;
      } catch (err) {
        return {
          name: 'Selected model',
          status: 'fail',
          message: `${model}: ${(err as Error).message}`,
          fix: 'Choose a reachable model with /model, or fix provider configuration',
        };
      }

      // OpenAI-compatible catalog probe for Cortex / vLLM routes.
      // baseUrl is private on VLlmProvider — resolve from config/env instead.
      const catalogProviders = new Set(['cortex', 'vllm', 'ollama']);
      if (catalogProviders.has(providerName)) {
        const {
          resolveCortexBaseUrl,
          resolveCortexAuthToken,
        } = await import('../provider/registry.js');

        let baseUrlRaw: string;
        if (providerName === 'cortex') {
          baseUrlRaw = resolveCortexBaseUrl(config);
        } else if (providerName === 'ollama') {
          baseUrlRaw =
            process.env['OLLAMA_BASE_URL']
            || config.providers?.ollama?.baseUrl
            || 'http://localhost:11434';
        } else {
          baseUrlRaw =
            process.env['VLLM_BASE_URL']
            || config.providers?.vllm?.baseUrl
            || 'http://localhost:8000';
        }
        const baseUrl = baseUrlRaw.replace(/\/+$/, '').replace(/\/v1$/, '');

        const headers: Record<string, string> = { Accept: 'application/json' };
        if (providerName === 'cortex') {
          const token = resolveCortexAuthToken(config);
          if (token) headers['Authorization'] = `Bearer ${token}`;
        } else {
          const key = process.env['VLLM_API_KEY'] || process.env['CORTEX_API_KEY'];
          if (key) headers['Authorization'] = `Bearer ${key}`;
        }

        let res: Response;
        try {
          // Hard wall-clock bound (SCLI-387 / alert #25183).
          res = await fetchWithDeadline(
            `${baseUrl}/v1/models`,
            { headers },
            'catalog probe',
          );
        } catch (err) {
          return {
            name: 'Selected model',
            status: 'fail',
            message: `${resolvedModel} via ${providerName}: catalog unreachable (${(err as Error).message})`,
            fix: 'Check CORTEX_BASE_URL / network, then retry /doctor or pick another model',
          };
        }

        if (!res.ok) {
          const body = await res.text().catch(() => '');
          const snippet = body.slice(0, 120).replace(/\s+/g, ' ');
          return {
            name: 'Selected model',
            status: 'fail',
            message: `${resolvedModel} via ${providerName}: catalog HTTP ${res.status}${snippet ? ` — ${snippet}` : ''}`,
            fix: res.status === 401 || res.status === 403
              ? 'Re-authenticate (shizuha login / Cortex API key) and retry'
              : 'Retry after Cortex recovery, or /model <reachable-id>',
          };
        }

        const payload = await res.json() as { data?: Array<{ id?: string }> };
        const ids = (payload.data ?? [])
          .map((row) => String(row.id || '').trim())
          .filter(Boolean);
        const matchedId = matchCatalogModelId(resolvedModel, ids);

        if (!matchedId) {
          const sample = ids.slice(0, 8).join(', ') || '(empty catalog)';
          return {
            name: 'Selected model',
            status: 'fail',
            message: `${resolvedModel} not in live ${providerName} catalog`,
            fix: `Model not available (model_not_found). Try /model with one of: ${sample}`,
          };
        }

        // SCLI-387 P2: catalog listing alone can false-PASS listed-but-dead
        // models (QA: DeepSeek-V4-Flash listed, completion 404). Tiny readiness
        // probe after catalog hit.
        const readiness = await probeModelCompletionReadiness({
          baseUrl,
          headers,
          modelId: matchedId,
        });
        if (readiness.status !== 'pass') {
          return {
            name: 'Selected model',
            status: readiness.status,
            message: `${resolvedModel} via ${providerName}: ${readiness.message}`,
            fix: readiness.fix,
          };
        }

        return {
          name: 'Selected model',
          status: 'pass',
          message: `${resolvedModel} reachable via ${providerName} (catalog+completion; ${ids.length} live model${ids.length === 1 ? '' : 's'})`,
        };
      }

      // Cloud provider without a local catalog probe — configured routing is enough.
      return {
        name: 'Selected model',
        status: 'pass',
        message: `${resolvedModel} routes to ${providerName} (configured)`,
      };
    } finally {
      setLogLevel(prevLevel);
    }
  } catch (err) {
    return {
      name: 'Selected model',
      status: 'fail',
      message: `Probe failed: ${(err as Error).message}`,
      fix: 'Retry /doctor; if it persists, check provider config and network',
    };
  }
}

function providerListIncludesCortex(cwd: string): Promise<boolean> {
  return (async () => {
    try {
      const { logger, setLogLevel } = await import('../utils/logger.js');
      const prev = logger.level;
      setLogLevel('silent');
      try {
        const { loadConfig } = await import('../config/loader.js');
        const config = await loadConfig(cwd);
        const { ProviderRegistry } = await import('../provider/registry.js');
        const registry = new ProviderRegistry(config);
        return registry.list().includes('cortex')
          || Boolean(process.env['CORTEX_BASE_URL']);
      } finally {
        setLogLevel(prev);
      }
    } catch {
      return Boolean(process.env['CORTEX_BASE_URL']);
    }
  })();
}

async function checkProviderConfig(cwd: string): Promise<DoctorCheck> {
  try {
    // Suppress pino log noise during provider initialization
    const { logger, setLogLevel } = await import('../utils/logger.js');
    const prevLevel = logger.level;
    setLogLevel('silent');

    const { loadConfig } = await import('../config/loader.js');
    const config = await loadConfig(cwd);
    const { ProviderRegistry } = await import('../provider/registry.js');
    const registry = new ProviderRegistry(config);

    // Restore log level
    setLogLevel(prevLevel);
    const providers = registry.list();

    if (providers.length === 0) {
      return {
        name: 'Provider config',
        status: 'fail',
        message: 'No providers configured',
        fix: 'Set an API key or run: shizuha auth codex',
      };
    }

    // Filter out 'ollama' since it's always registered
    const cloudProviders = providers.filter(p => p !== 'ollama');
    if (cloudProviders.length === 0) {
      return {
        name: 'Provider config',
        status: 'warn',
        message: 'Only local (Ollama) provider available',
        fix: 'Set an API key for a cloud provider, or run: shizuha auth codex',
      };
    }

    return {
      name: 'Provider config',
      status: 'pass',
      message: `${providers.length} provider${providers.length > 1 ? 's' : ''} available: ${providers.join(', ')}`,
    };
  } catch (err) {
    return {
      name: 'Provider config',
      status: 'fail',
      message: `Failed to load providers: ${(err as Error).message}`,
    };
  }
}

async function checkSqlite(): Promise<DoctorCheck> {
  const home = process.env['HOME'] ?? os.homedir();
  const dir = path.join(home, '.config', 'shizuha');

  try {
    const Database = (await import('better-sqlite3')).default;
    // Ensure dir exists
    fs.mkdirSync(dir, { recursive: true });
    const testPath = path.join(dir, 'state.db');
    const db = new Database(testPath);
    db.pragma('journal_mode = WAL');
    // Quick sanity check
    db.exec('SELECT 1');
    db.close();
    return { name: 'SQLite state store', status: 'pass', message: 'OK' };
  } catch (err) {
    return {
      name: 'SQLite state store',
      status: 'fail',
      message: `Cannot open state database: ${(err as Error).message}`,
      fix: 'Check that better-sqlite3 is installed and ~/.config/shizuha/ is writable',
    };
  }
}

async function checkMcpServers(cwd: string): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const home = process.env['HOME'] ?? os.homedir();

  // Look for .mcp.json
  const mcpPaths = [
    path.join(cwd, '.mcp.json'),
    path.join(home, '.mcp.json'),
  ];

  let mcpFile: string | null = null;
  let serverDefs: Record<string, Record<string, unknown>> = {};

  for (const p of mcpPaths) {
    try {
      const content = await fsp.readFile(p, 'utf-8');
      const data = JSON.parse(content) as Record<string, unknown>;
      const servers = data['mcpServers'] as Record<string, Record<string, unknown>> | undefined;
      if (servers && typeof servers === 'object') {
        mcpFile = p;
        serverDefs = servers;
        break;
      }
    } catch {
      // skip
    }
  }

  if (!mcpFile) {
    checks.push({
      name: 'MCP servers',
      status: 'warn',
      message: 'No .mcp.json found',
      fix: 'Create .mcp.json in project root or home directory to configure MCP tool servers',
    });
    return checks;
  }

  const serverNames = Object.keys(serverDefs);
  checks.push({
    name: 'MCP servers',
    status: 'pass',
    message: `${serverNames.length} server${serverNames.length !== 1 ? 's' : ''} configured in ${path.basename(mcpFile)}`,
  });

  // Check that stdio server commands are accessible
  for (const [name, def] of Object.entries(serverDefs)) {
    if (def['url']) continue; // HTTP-based, no command to check
    const command = def['command'] as string | undefined;
    if (!command) continue;

    // Check if command exists on PATH
    const { execFileSync } = await import('node:child_process');
    try {
      execFileSync('which', [command], { stdio: 'pipe' });
      // command found, skip individual check (already covered by the aggregate)
    } catch {
      checks.push({
        name: `MCP server: ${name}`,
        status: 'warn',
        message: `Command "${command}" not found on PATH`,
        fix: `Install ${command} or check your PATH`,
      });
    }
  }

  return checks;
}

async function checkDiskSpace(): Promise<DoctorCheck> {
  const home = process.env['HOME'] ?? os.homedir();

  try {
    const stats = fs.statfsSync(home);
    const freeBytes = stats.bfree * stats.bsize;
    const freeGB = freeBytes / (1024 * 1024 * 1024);

    if (freeGB < 1) {
      return {
        name: 'Disk space',
        status: 'warn',
        message: `${freeGB.toFixed(1)}GB free (< 1GB)`,
        fix: 'Free up disk space in your home directory',
      };
    }
    return {
      name: 'Disk space',
      status: 'pass',
      message: `${freeGB.toFixed(0)}GB free`,
    };
  } catch {
    return {
      name: 'Disk space',
      status: 'warn',
      message: 'Could not determine free disk space',
    };
  }
}

async function checkPermissions(): Promise<DoctorCheck> {
  const home = process.env['HOME'] ?? os.homedir();
  const shizuhaDir = path.join(home, '.config', 'shizuha');

  try {
    fs.mkdirSync(shizuhaDir, { recursive: true });
    // Try writing a temp file
    const testFile = path.join(shizuhaDir, '.doctor-test');
    fs.writeFileSync(testFile, 'test');
    fs.unlinkSync(testFile);
    return { name: 'Permissions', status: 'pass', message: `~/.config/shizuha/ is writable` };
  } catch {
    return {
      name: 'Permissions',
      status: 'fail',
      message: `Cannot write to ${shizuhaDir}`,
      fix: `chmod -R u+w ${shizuhaDir}`,
    };
  }
}

async function checkDependencies(): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const deps: Array<[string, string]> = [
    ['zod', 'zod'],
    ['better-sqlite3', 'better-sqlite3'],
  ];

  for (const [name, pkg] of deps) {
    try {
      await import(pkg);
      checks.push({ name: `Dependency: ${name}`, status: 'pass', message: 'importable' });
    } catch {
      checks.push({
        name: `Dependency: ${name}`,
        status: 'fail',
        message: 'not importable',
        fix: `npm install ${pkg}`,
      });
    }
  }

  return checks;
}

export interface BuildCheckInput {
  /** Absolute directory containing the running module (e.g. <repo>/dist or /opt/shizuha/dist). */
  moduleDir: string;
  /** True when running from a source checkout (sibling src/ + package.json). */
  isSource: boolean;
}

/** Pure build-truth resolution (SCLI-396). Never consults process.cwd().
 *
 * - Source checkout: the built output IS <moduleDir>/shizuha.js; a missing or
 *   stale dist means `npm run build`.
 * - Installed distribution: the running bundle IS the build; recovery is an
 *   update/reinstall, never a source build.
 *
 * Exported for the regression matrix; `checkBuild()` wraps it with the real
 * module location.
 */
export async function resolveBuildCheck({ moduleDir, isSource }: BuildCheckInput): Promise<DoctorCheck> {
  const distPath = path.join(moduleDir, 'shizuha.js');
  try {
    const stat = await fsp.stat(distPath);
    const age = Date.now() - stat.mtimeMs;
    const ageHours = age / (1000 * 60 * 60);
    if (ageHours > 24) {
      return {
        name: 'Build',
        status: 'warn',
        message: isSource
          ? `dist/shizuha.js exists but is ${ageHours.toFixed(0)}h old`
          : `installed bundle exists but is ${ageHours.toFixed(0)}h old`,
        fix: isSource ? 'npm run build' : 'shizuha update',
      };
    }
    return {
      name: 'Build',
      status: 'pass',
      message: isSource
        ? `dist/shizuha.js exists (${ageHours < 1 ? 'less than 1h' : ageHours.toFixed(0) + 'h'} old)`
        : `installed bundle exists (${ageHours < 1 ? 'less than 1h' : ageHours.toFixed(0) + 'h'} old)`,
    };
  } catch {
    return {
      name: 'Build',
      status: 'warn',
      message: isSource ? 'dist/shizuha.js not found' : 'installed bundle not found',
      fix: isSource ? 'npm run build' : 'reinstall shizuha (see https://shizuha.com/install.sh)',
    };
  }
}

async function checkBuild(): Promise<DoctorCheck> {
  // Resolve the running module's own location — NEVER the caller CWD. An
  // installed distribution must report its own build truth regardless of the
  // directory it is invoked from (SCLI-396: `dist/shizuha.js not found` +
  // `npm run build` fired from /tmp/workspace against a healthy /opt/shizuha
  // install, purely because the first candidate used process.cwd()).
  const here = path.dirname(fileURLToPath(import.meta.url));

  // Source checkout: <repo>/dist/shizuha.js with a sibling src/ + package.json.
  // Only here is `npm run build` a valid recovery action.
  const isSource =
    fs.existsSync(path.join(here, '..', 'src')) &&
    fs.existsSync(path.join(here, '..', 'package.json'));

  return resolveBuildCheck({ moduleDir: here, isSource });
}

export interface RunDoctorOptions {
  /** Session-selected model id (from TUI /model or CLI --model). */
  selectedModel?: string;
}

/**
 * Format doctor checks as plain text (TUI /doctor, logs).
 */
export function formatDoctorChecksPlain(checks: DoctorCheck[]): string {
  const icons: Record<DoctorCheck['status'], string> = {
    pass: '\u2713',
    warn: '\u26A0',
    fail: '\u2717',
  };
  const lines: string[] = ['shizuha doctor', '==============', ''];
  for (const check of checks) {
    lines.push(`${icons[check.status]} ${check.name}: ${check.message}`);
    if (check.fix && check.status !== 'pass') {
      lines.push(`  Fix: ${check.fix}`);
    }
  }
  const passed = checks.filter((c) => c.status === 'pass').length;
  const warnings = checks.filter((c) => c.status === 'warn').length;
  const failed = checks.filter((c) => c.status === 'fail').length;
  lines.push('');
  lines.push(
    `Results: ${passed} passed, ${warnings} warning${warnings !== 1 ? 's' : ''}, ${failed} failed`,
  );
  return lines.join('\n');
}

/**
 * Run all doctor checks and return results.
 * SCLI-387: includes selected-model reachability and Cortex-aware API-key N/A.
 */
export async function runDoctor(
  cwd: string = process.cwd(),
  options: RunDoctorOptions = {},
): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const cortexPrimary = await providerListIncludesCortex(cwd);

  // Synchronous checks
  checks.push(checkNodeVersion());

  // Async checks
  checks.push(await checkConfigFile(cwd));

  // API keys (N/A for public vendors when Cortex is the primary route)
  checks.push(...checkApiKeys({ cortexPrimary }));

  // Provider config (loads config + registry)
  checks.push(await checkProviderConfig(cwd));

  // SCLI-387: selected model live reachability
  checks.push(await checkSelectedModelReachability(cwd, options.selectedModel));

  // SQLite
  checks.push(await checkSqlite());

  // MCP servers
  checks.push(...await checkMcpServers(cwd));

  // Disk space
  checks.push(await checkDiskSpace());

  // Permissions
  checks.push(await checkPermissions());

  // Dependencies
  checks.push(...await checkDependencies());

  // Build
  checks.push(await checkBuild());

  return checks;
}
