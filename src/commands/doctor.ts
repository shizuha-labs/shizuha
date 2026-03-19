import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

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

function statusIcon(status: 'pass' | 'warn' | 'fail'): string {
  switch (status) {
    case 'pass': return `${GREEN}\u2713${RESET}`;
    case 'warn': return `${YELLOW}\u26A0${RESET}`;
    case 'fail': return `${RED}\u2717${RESET}`;
  }
}

export function printChecks(checks: DoctorCheck[]): void {
  console.log(`\n${BOLD}shizuha doctor${RESET}`);
  console.log('==============\n');

  for (const check of checks) {
    console.log(`${statusIcon(check.status)} ${check.name}: ${check.message}`);
    if (check.fix) {
      console.log(`  ${DIM}Fix: ${check.fix}${RESET}`);
    }
  }

  const passed = checks.filter(c => c.status === 'pass').length;
  const warnings = checks.filter(c => c.status === 'warn').length;
  const failed = checks.filter(c => c.status === 'fail').length;

  console.log(`\nResults: ${GREEN}${passed} passed${RESET}, ${YELLOW}${warnings} warning${warnings !== 1 ? 's' : ''}${RESET}, ${RED}${failed} failed${RESET}`);
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
): DoctorCheck {
  const value = process.env[envVar];
  if (value) {
    // Mask the key for display
    const masked = value.slice(0, 8) + '...' + value.slice(-4);
    return { name: envVar, status: 'pass', message: `set (${masked})` };
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

function checkApiKeys(): DoctorCheck[] {
  const keys: Array<[string, string, boolean]> = [
    ['Anthropic', 'ANTHROPIC_API_KEY', false],
    ['OpenAI', 'OPENAI_API_KEY', false],
    ['Google', 'GOOGLE_API_KEY', false],
  ];

  const checks = keys.map(([name, envVar, required]) => checkApiKey(name, envVar, required));

  // If none are set, make it a warning
  const anySet = keys.some(([, envVar]) => process.env[envVar]);
  if (!anySet) {
    // Check for codex auth as well
    const home = process.env['HOME'] ?? os.homedir();
    const codexAuthPath = path.join(home, '.shizuha', 'credentials.json');
    let hasCodexAuth = false;
    try {
      const creds = JSON.parse(fs.readFileSync(codexAuthPath, 'utf-8'));
      hasCodexAuth = !!(creds.codex?.accessToken || creds.codex?.refreshToken);
    } catch {
      // no credentials file
    }

    if (!hasCodexAuth) {
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

async function checkBuild(): Promise<DoctorCheck> {
  // Find dist/shizuha.js relative to the package
  const candidates = [
    path.join(process.cwd(), 'dist', 'shizuha.js'),
    path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'dist', 'shizuha.js'),
  ];

  for (const distPath of candidates) {
    try {
      const stat = await fsp.stat(distPath);
      const age = Date.now() - stat.mtimeMs;
      const ageHours = age / (1000 * 60 * 60);

      if (ageHours > 24) {
        return {
          name: 'Build',
          status: 'warn',
          message: `dist/shizuha.js exists but is ${ageHours.toFixed(0)}h old`,
          fix: 'npm run build',
        };
      }

      return {
        name: 'Build',
        status: 'pass',
        message: `dist/shizuha.js exists (${ageHours < 1 ? 'less than 1h' : ageHours.toFixed(0) + 'h'} old)`,
      };
    } catch {
      // try next candidate
    }
  }

  return {
    name: 'Build',
    status: 'warn',
    message: 'dist/shizuha.js not found',
    fix: 'npm run build',
  };
}

export async function runDoctor(cwd: string): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];

  // Synchronous checks
  checks.push(checkNodeVersion());

  // Async checks
  checks.push(await checkConfigFile(cwd));

  // API keys
  checks.push(...checkApiKeys());

  // Provider config (loads config + registry)
  checks.push(await checkProviderConfig(cwd));

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
