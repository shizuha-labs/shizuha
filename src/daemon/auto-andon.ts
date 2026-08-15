import type { AgentInfo, DaemonConfig } from './types.js';
import { sendConnectDm } from '../platform/connect-dm.js';

export type AutoAndonPattern = 'empty-turn-streak' | 'same-error-streak' | 'identical-failing-tool-call';

export interface AutoAndonSignal {
  pattern: AutoAndonPattern;
  signature: string;
  count: number;
  detail: string;
  excerpt: string;
}

interface ToolFailureSample {
  kind: string;
  name: string;
  status: string;
}

interface AgentThrashState {
  lastErrorSignature?: string;
  sameErrorCount: number;
  lastErrorAt?: number;
  lastToolSignature?: string;
  sameToolFailureCount: number;
  lastToolFailureAt?: number;
}

export interface AutoAndonMetricsSnapshot {
  firedTotal: number;
  sendFailedTotal: number;
  rateLimitedTotal: number;
}

export const AUTO_ANDON_RATE_LIMIT_MS = 6 * 60 * 60 * 1000;
export const AUTO_ANDON_EMPTY_TURN_THRESHOLD = 3;
export const AUTO_ANDON_SAME_ERROR_THRESHOLD = 3;
export const AUTO_ANDON_TOOL_FAILURE_THRESHOLD = 3;
export const AUTO_ANDON_STREAK_WINDOW_MS = 15 * 60 * 1000;

// PLAT-1254 invariant: when an agent thrashes past threshold, its cluster manager
// receives one auto-andon DM within the detector turn path unless the same
// agent/obstacle was successfully sent in the previous 6h. These counters make
// the notifier's liveness/failure path visible on the daemon health exporter.
const autoAndonMetrics: AutoAndonMetricsSnapshot = {
  firedTotal: 0,
  sendFailedTotal: 0,
  rateLimitedTotal: 0,
};

const agentStates = new Map<string, AgentThrashState>();
const lastSentByAgentObstacle = new Map<string, number>();

const MANAGER_BY_CLUSTER: Array<{ teams: string[]; manager: string }> = [
  { teams: ['engineering', 'architecture', 'review', 'merge', 'qa'], manager: 'aoi' },
  { teams: ['devops', 'it', 'security', 'platform'], manager: 'ichi' },
  { teams: ['product', 'design', 'documentation', 'docs', 'research-analytics'], manager: 'sora' },
  {
    teams: [
      'accounting', 'legal', 'people', 'marketing', 'sales', 'customer-support',
      'social-media', 'governance', 'quant-research', 'trading-engineering',
      'risk-validation', 'trading-ops', 'sec-research', 'sec-risk-validation', 'sec-ops',
    ],
    manager: 'banto',
  },
];

export function resolveClusterManagerUsername(team?: string | null): string {
  const normalized = (team || '').trim().toLowerCase();
  for (const entry of MANAGER_BY_CLUSTER) {
    if (entry.teams.includes(normalized)) return entry.manager;
  }
  // Engineering is the safest default for unknown fleet-runtime code paths: Aoi owns build-pipeline managers.
  return 'aoi';
}

export function resetAutoAndonStateForTests(): void {
  agentStates.clear();
  lastSentByAgentObstacle.clear();
  autoAndonMetrics.firedTotal = 0;
  autoAndonMetrics.sendFailedTotal = 0;
  autoAndonMetrics.rateLimitedTotal = 0;
}

export function recordAutoAndonFired(): void {
  autoAndonMetrics.firedTotal += 1;
}

export function recordAutoAndonSendFailed(): void {
  autoAndonMetrics.sendFailedTotal += 1;
}

export function getAutoAndonMetricsSnapshot(): AutoAndonMetricsSnapshot {
  return { ...autoAndonMetrics };
}

function rateLimitKey(agentId: string, signal: AutoAndonSignal): string {
  return `${agentId}:${signal.pattern}:${signal.signature}`;
}

export function clearAutoAndonRateLimit(agentId: string, signal: AutoAndonSignal): void {
  lastSentByAgentObstacle.delete(rateLimitKey(agentId, signal));
}

function normalizeForSignature(text: string): string {
  return text
    .replace(/\b[0-9a-f]{8,}\b/gi, '<hex>')
    .replace(/\b\d{2,}\b/g, '<num>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 220);
}

function extractErrorSignature(text: string): string | null {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    if (line.length > 500) continue;
    const explicit = line.match(/(?:^|\s)((?:\w+)?Error):\s*(.+)$/);
    if (explicit?.[2]) return normalizeForSignature(`${explicit[1]}: ${explicit[2]}`);
    if (/\b(failed|failure|exception|traceback|panic|permission denied|timeout|timed out|not authenticated|not configured)\b/i.test(line)) {
      return normalizeForSignature(line);
    }
  }
  return null;
}

function parseKeyValue(line: string, key: string): string {
  const m = line.match(new RegExp(`${key}=("(?:\\\\.|[^"])*"|\\S*)`));
  if (!m?.[1]) return '';
  const raw = m[1];
  if (raw.startsWith('"')) {
    try { return JSON.parse(raw); } catch { return raw.slice(1, -1); }
  }
  return raw;
}

function parseFailingToolCall(line: string): ToolFailureSample | null {
  if (!line.includes('[codex-rpc]')) return null;
  const status = parseKeyValue(line, 'status').toLowerCase().replace(/[_.-]/g, '');
  if (!['failed', 'failure', 'error', 'errored', 'cancelled', 'canceled'].includes(status)) return null;
  const itemType = parseKeyValue(line, 'item\\.type');
  if (itemType === 'mcpToolCall') {
    const server = parseKeyValue(line, 'server') || 'mcp';
    const tool = parseKeyValue(line, 'tool') || 'tool';
    return { kind: 'mcpToolCall', name: `${server}:${tool}`, status };
  }
  if (itemType === 'commandExecution') {
    const command = normalizeForSignature(parseKeyValue(line, 'command') || 'commandExecution');
    return { kind: 'commandExecution', name: command, status };
  }
  return null;
}

function buildSignalFromLine(agentId: string, line: string, stream: 'stdout' | 'stderr', now: number): AutoAndonSignal | null {
  const state = agentStates.get(agentId) ?? { sameErrorCount: 0, sameToolFailureCount: 0 };
  agentStates.set(agentId, state);

  const empty = line.match(/\[codex-bridge\]\s+Empty turn #(\d+)/)
    ?? line.match(/\[codex-bridge\]\s+(\d+) consecutive empty turns/);
  if (empty?.[1]) {
    const count = Number(empty[1]);
    if (count >= AUTO_ANDON_EMPTY_TURN_THRESHOLD) {
      return {
        pattern: 'empty-turn-streak',
        signature: 'empty-turn-streak',
        count,
        detail: `${count} consecutive empty turns`,
        excerpt: line.slice(0, 500),
      };
    }
    return null;
  }

  const failingTool = parseFailingToolCall(line);
  if (failingTool) {
    const signature = `${failingTool.kind}:${failingTool.name}:${failingTool.status}`;
    if (state.lastToolSignature === signature && state.lastToolFailureAt !== undefined && now - state.lastToolFailureAt <= AUTO_ANDON_STREAK_WINDOW_MS) {
      state.sameToolFailureCount += 1;
    } else {
      state.lastToolSignature = signature;
      state.sameToolFailureCount = 1;
    }
    state.lastToolFailureAt = now;
    if (state.sameToolFailureCount >= AUTO_ANDON_TOOL_FAILURE_THRESHOLD) {
      return {
        pattern: 'identical-failing-tool-call',
        signature,
        count: state.sameToolFailureCount,
        detail: `${state.sameToolFailureCount} repeated failing ${failingTool.kind} ${failingTool.name}`,
        excerpt: line.slice(0, 500),
      };
    }
    return null;
  }

  if (stream === 'stderr') {
    const errorSignature = extractErrorSignature(line);
    if (errorSignature) {
      if (state.lastErrorSignature === errorSignature && state.lastErrorAt !== undefined && now - state.lastErrorAt <= AUTO_ANDON_STREAK_WINDOW_MS) {
        state.sameErrorCount += 1;
      } else {
        state.lastErrorSignature = errorSignature;
        state.sameErrorCount = 1;
      }
      state.lastErrorAt = now;
      if (state.sameErrorCount >= AUTO_ANDON_SAME_ERROR_THRESHOLD) {
        return {
          pattern: 'same-error-streak',
          signature: errorSignature,
          count: state.sameErrorCount,
          detail: `${state.sameErrorCount} repeated stderr errors`,
          excerpt: line.slice(0, 500),
        };
      }
    }
  }

  return null;
}

export function shouldRateLimitAutoAndon(agentId: string, signal: AutoAndonSignal, now = Date.now()): boolean {
  const key = rateLimitKey(agentId, signal);
  const lastSent = lastSentByAgentObstacle.get(key);
  if (lastSent !== undefined && now - lastSent < AUTO_ANDON_RATE_LIMIT_MS) {
    autoAndonMetrics.rateLimitedTotal += 1;
    return true;
  }
  lastSentByAgentObstacle.set(key, now);
  return false;
}

export function observeAutoAndonLine(agentId: string, line: string, stream: 'stdout' | 'stderr', now = Date.now()): AutoAndonSignal | null {
  const signal = buildSignalFromLine(agentId, line, stream, now);
  if (!signal) return null;
  if (shouldRateLimitAutoAndon(agentId, signal, now)) return null;
  return signal;
}

function platformBase(config: DaemonConfig): string {
  return config.platformUrl || process.env['SHIZUHA_PLATFORM_URL'] || process.env['BACKEND_URL'] || '';
}

function autoAndonContent(agent: AgentInfo, signal: AutoAndonSignal): string {
  return [
    '## 🟠 AUTO-ANDON — bridge thrash detected',
    `- Agent: ${agent.name} (@${agent.username})`,
    `- Team: ${agent.team || 'unknown'} → manager ${resolveClusterManagerUsername(agent.team)}`,
    `- Pattern: ${signal.pattern}`,
    `- Count: ${signal.count}`,
    `- Stuck on: ${signal.detail}`,
    `- Evidence: ${signal.excerpt}`,
    '- Need: direction-check the task/artifact trail and unblock, reroute, premise-kill, or escalate per the manager skill.',
    '',
    'Detector: PLAT-1242 bridge-level auto-andon. Existing restart/self-heal behavior continues separately; this DM is rate-limited per agent/obstacle for 6h.',
  ].join('\n');
}

export async function sendAutoAndonToClusterManager(opts: {
  agent: AgentInfo;
  config: DaemonConfig;
  signal: AutoAndonSignal;
  senderPassword?: string;
}): Promise<void> {
  const manager = resolveClusterManagerUsername(opts.agent.team);
  const result = await sendConnectDm({
    recipientUsername: manager,
    content: autoAndonContent(opts.agent, opts.signal),
    platformUrl: platformBase(opts.config),
    sender: {
      username: opts.agent.username,
      email: opts.agent.email || `${opts.agent.username}@agents.shizuha.io`,
      agentId: opts.agent.id,
      isAgent: true,
    },
    senderPassword: opts.senderPassword,
    timeoutMs: 10_000,
  });
  if (!result.ok) {
    throw new Error(result.error || `Connect DM failed with status ${result.status ?? 'unknown'}`);
  }
}
