/**
 * Self-declared client identity sent to Cortex on every request.
 *
 * Operator 2026-08-06, on tracing a 24h / 471-request session that ran under
 * their own JWT: "it used my jwt but i don't remember doing any request
 * related to this". Cortex recorded WHO (principal) and WHICH CONVERSATION
 * (affinity key) but never WHAT PROGRAM — so attributing a usage row to a
 * process meant walking /proc on the calling host, and even that was
 * inconclusive once the process had exited.
 *
 * These headers are descriptive telemetry only. Cortex stores them as labels
 * beside the usage row and must never use them for authorization, routing, or
 * billing (they are trivially forgeable — the bearer token remains the only
 * authority).
 */
import * as os from 'node:os';

let cached: Record<string, string> | null = null;

/** Header-safe: printable ASCII, no CR/LF, bounded. */
function sanitize(value: string, max: number): string {
  return value
    .replace(/[^\x20-\x7E]/g, '')
    .trim()
    .slice(0, max);
}

function cliSubcommand(): string {
  // Only the CLI subcommand identifies the process. Scanning the full argv
  // (including `--prompt`) mislabeled bench `exec` cells as scli-daemon
  // whenever the prompt contained the words "up" or "daemon"
  // (Metal chess Usage 114f43796382, 2026-09-05).
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (!token || token === '--') continue;
    if (token.startsWith('-')) {
      const next = args[i + 1];
      if (!token.includes('=') && next && !next.startsWith('-')) i += 1;
      continue;
    }
    return token;
  }
  return '';
}

function detectKind(): string {
  const explicit = process.env['SHIZUHA_CLIENT_KIND']?.trim();
  if (explicit) return explicit;
  const sub = cliSubcommand();
  if (sub === 'gateway') return 'scli-gateway';
  if (sub === 'up' || sub === 'daemon') return 'scli-daemon';
  if (sub === 'exec') return 'scli-exec';
  if (sub === 'serve') return 'scli-serve';
  // The TUI is the no-subcommand default.
  return process.stdout.isTTY ? 'scli-tui' : 'scli';
}

/**
 * A stable per-process instance id. Deliberately NOT the conversation id: the
 * point is to distinguish two processes that share a session id (a resumed
 * session) and to survive a session the client never persisted.
 */
function instanceId(): string {
  return `${process.pid}-${Math.round(Date.now() / 1000 - process.uptime())}`;
}

export function cortexClientHeaders(): Record<string, string> {
  if (cached) return cached;
  const kind = sanitize(detectKind(), 40);
  const host = sanitize(os.hostname(), 60);
  const pid = String(process.pid);
  // tmux/terminal context is what makes a host process findable by a human —
  // "which of my panes is this" is the actual question being asked.
  const tmux = sanitize(process.env['TMUX_PANE'] ?? '', 20);
  const agent = sanitize(process.env['SHIZUHA_AGENT_USERNAME'] ?? '', 40);
  const parts = [`${kind}`, `host=${host}`, `pid=${pid}`];
  if (tmux) parts.push(`tmux=${tmux}`);
  if (agent) parts.push(`agent=${agent}`);
  cached = {
    'X-Cortex-Client': sanitize(parts.join(' '), 200),
    'X-Cortex-Client-Kind': kind,
    'X-Cortex-Client-Host': host,
    'X-Cortex-Client-Pid': pid,
    'X-Cortex-Client-Instance': instanceId(),
  };
  return cached;
}

/** Test seam: clear the per-process memoization. */
export function resetCortexClientHeadersCache(): void {
  cached = null;
}
