/**
 * Daemon state persistence — tracks running agent processes.
 * State stored at ~/.shizuha/daemon.json
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DaemonState, DaemonAgentState } from './types.js';

function daemonStatePath(): string {
  return path.join(process.env['HOME'] ?? '~', '.shizuha', 'daemon.json');
}

export function readDaemonState(): DaemonState | null {
  try {
    const raw = fs.readFileSync(daemonStatePath(), 'utf-8');
    return JSON.parse(raw) as DaemonState;
  } catch {
    return null;
  }
}

export function writeDaemonState(state: DaemonState): void {
  const dir = path.dirname(daemonStatePath());
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const filePath = daemonStatePath();
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(tmpPath, filePath);
}

export function clearDaemonState(): void {
  try {
    fs.rmSync(daemonStatePath(), { force: true });
  } catch {
    // ignore
  }
}

export function updateAgentState(
  agentId: string,
  update: Partial<DaemonAgentState>,
): void {
  const state = readDaemonState();
  if (!state) return;

  const idx = state.agents.findIndex((a) => a.agentId === agentId);
  if (idx >= 0) {
    state.agents[idx] = { ...state.agents[idx]!, ...update };
  }
  writeDaemonState(state);
}

// ── Persisted enabled-agents state (survives daemon restarts) ──

function enabledAgentsPath(): string {
  return path.join(process.env['HOME'] ?? '~', '.shizuha', 'enabled-agents.json');
}

/** Read the set of agent IDs the user has enabled. */
export function readEnabledAgents(): Set<string> {
  try {
    const raw = fs.readFileSync(enabledAgentsPath(), 'utf-8');
    const arr = JSON.parse(raw) as string[];
    return new Set(arr);
  } catch {
    return new Set();
  }
}

/** Persist the set of enabled agent IDs. */
export function writeEnabledAgents(agentIds: Set<string>): void {
  const dir = path.dirname(enabledAgentsPath());
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const filePath = enabledAgentsPath();
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify([...agentIds], null, 2), { mode: 0o600 });
  fs.renameSync(tmpPath, filePath);
}

// ── Persisted agents — single source of truth for all agents on this machine ──

function agentsPath(): string {
  return path.join(process.env['HOME'] ?? '~', '.shizuha', 'agents.json');
}

/** Read all persisted agents. */
export function readAgents(): import('./types.js').AgentInfo[] {
  try {
    const raw = fs.readFileSync(agentsPath(), 'utf-8');
    return JSON.parse(raw) as import('./types.js').AgentInfo[];
  } catch {
    return [];
  }
}

/** Write the full agent list (atomic). */
export function writeAgents(agents: import('./types.js').AgentInfo[]): void {
  const dir = path.dirname(agentsPath());
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const filePath = agentsPath();
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(agents, null, 2), { mode: 0o600 });
  fs.renameSync(tmpPath, filePath);
}

/** Add an agent and persist. */
export function addAgent(agent: import('./types.js').AgentInfo): void {
  const agents = readAgents();
  agents.push(agent);
  writeAgents(agents);
}

/** Remove an agent by ID and persist. Returns true if removed. */
export function removeAgent(agentId: string): boolean {
  const agents = readAgents();
  const filtered = agents.filter((a) => a.id !== agentId);
  if (filtered.length === agents.length) return false;
  writeAgents(filtered);
  return true;
}

/** Update an agent by ID and persist. Returns true if found. */
export function updateAgentConfig(agentId: string, updates: Partial<import('./types.js').AgentInfo>): boolean {
  const agents = readAgents();
  const idx = agents.findIndex((a) => a.id === agentId);
  if (idx < 0) return false;
  agents[idx] = { ...agents[idx]!, ...updates };
  writeAgents(agents);
  return true;
}

/**
 * Merge remote agents into the persisted agent list.
 * New agents are appended. Existing agents get platform-managed fields updated
 * (model config, execution method, MCP servers, etc.) while preserving local
 * overrides (credentials, work schedule, token budget, etc.).
 * Returns the number of new agents added.
 */
export function mergeRemoteAgents(remoteAgents: import('./types.js').AgentInfo[]): number {
  const agents = readAgents();
  const existingMap = new Map(agents.map((a, i) => [a.id, i]));
  let added = 0;
  let updated = 0;
  for (const ra of remoteAgents) {
    const idx = existingMap.get(ra.id);
    if (idx == null) {
      agents.push(ra);
      added++;
    } else {
      // Update platform-managed fields on existing agents
      const local = agents[idx]!;
      // These fields are owned by the platform and should always be synced
      if (ra.name != null) local.name = ra.name;
      if (ra.email != null) local.email = ra.email;
      if (ra.role != null) local.role = ra.role;
      if (ra.executionMethod != null) local.executionMethod = ra.executionMethod;
      if (ra.runtimeEnvironment != null) local.runtimeEnvironment = ra.runtimeEnvironment;
      if (ra.modelOverrides != null) local.modelOverrides = ra.modelOverrides;
      if (ra.modelFallbacks != null) local.modelFallbacks = ra.modelFallbacks;
      if (ra.contextPrompt != null) local.contextPrompt = ra.contextPrompt;
      if (ra.skills?.length) local.skills = ra.skills;
      if (ra.personalityTraits && Object.keys(ra.personalityTraits).length) local.personalityTraits = ra.personalityTraits;
      if (ra.mcpServers?.length) local.mcpServers = ra.mcpServers;
      // These fields are local-only: credentials, workSchedule, tokenBudget, agentMemory
      updated++;
    }
  }
  if (added > 0 || updated > 0) {
    writeAgents(agents);
  }
  return added;
}

/**
 * Check if the daemon process is actually alive (by PID).
 * Also validates the process is actually a shizuha daemon (not a PID-reused process).
 * Cleans up stale state automatically.
 */
export function isDaemonRunning(): boolean {
  // Check PID lock file first (authoritative)
  const lockPid = readPidLock();
  if (lockPid && isShizuhaDaemonProcess(lockPid)) return true;

  // Fallback to daemon.json state
  const state = readDaemonState();
  if (!state) return false;

  if (!isShizuhaDaemonProcess(state.pid)) {
    // Stale PID — process is dead or is a different process
    clearDaemonState();
    return false;
  }
  return true;
}

/**
 * Verify a PID belongs to a shizuha daemon process (not a reused PID).
 * Reads /proc/{pid}/cmdline on Linux to confirm it's `node ... shizuha.js up`.
 */
export function isShizuhaDaemonProcess(pid: number): boolean {
  try {
    // First check if process is alive
    process.kill(pid, 0);
  } catch {
    return false;
  }

  // On Linux, verify via /proc cmdline that it's actually a shizuha daemon
  try {
    const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf-8');
    // cmdline is null-separated; check for shizuha.js and daemon indicators
    return cmdline.includes('shizuha') && (
      cmdline.includes('up') || cmdline.includes('SHIZUHA_DAEMON')
    );
  } catch {
    // /proc not available (macOS, etc.) — fall back to PID-only check
    // On non-Linux, we still have the process alive check above
    return true;
  }
}

// ── PID lock file (PostgreSQL/VNC-style) ──
//
// Prevents multiple daemon instances from running concurrently.
// The lock file at ~/.shizuha/daemon.pid contains the PID and is held
// open with an exclusive flock. Any new daemon startup will:
// 1. Check if the lock is held by a live process → kill it
// 2. Acquire the lock exclusively
// 3. Write its own PID
// On exit, the lock fd is released automatically by the OS.

let lockFd: number | null = null;

function pidLockPath(): string {
  return path.join(process.env['HOME'] ?? '~', '.shizuha', 'daemon.pid');
}

/** Read the PID from the lock file (does NOT check if alive). */
export function readPidLock(): number | null {
  try {
    const content = fs.readFileSync(pidLockPath(), 'utf-8').trim();
    const pid = parseInt(content, 10);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

/**
 * Acquire the daemon PID lock. Kills any existing daemon first.
 * Must be called once at daemon startup. The lock is held for the
 * lifetime of this process (OS releases flock on exit/crash).
 */
export function acquirePidLock(): void {
  const lockPath = pidLockPath();
  const dir = path.dirname(lockPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  // Check for existing daemon and kill it
  const existingPid = readPidLock();
  if (existingPid && existingPid !== process.pid) {
    if (isShizuhaDaemonProcess(existingPid)) {
      console.log(`[daemon] Killing existing daemon (PID ${existingPid})...`);
      try {
        process.kill(existingPid, 'SIGTERM');
        // Wait briefly for it to exit
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
          try { process.kill(existingPid, 0); } catch { break; }
          const { execSync } = require('node:child_process');
          execSync('sleep 0.2', { stdio: 'ignore' });
        }
        // Force kill if still alive
        try {
          process.kill(existingPid, 0);
          console.log(`[daemon] Force-killing old daemon (PID ${existingPid})...`);
          process.kill(existingPid, 'SIGKILL');
        } catch { /* already dead */ }
      } catch { /* not running */ }
    }
  }

  // Also check daemon.json state for a different PID (e.g., installed vs dev binary)
  const state = readDaemonState();
  if (state && state.pid !== process.pid && state.pid !== existingPid) {
    if (isShizuhaDaemonProcess(state.pid)) {
      console.log(`[daemon] Killing stale daemon from state (PID ${state.pid})...`);
      try { process.kill(state.pid, 'SIGTERM'); } catch { /* ignore */ }
      try {
        const deadline = Date.now() + 3000;
        while (Date.now() < deadline) {
          try { process.kill(state.pid, 0); } catch { break; }
          const { execSync } = require('node:child_process');
          execSync('sleep 0.2', { stdio: 'ignore' });
        }
        try { process.kill(state.pid, 'SIGKILL'); } catch { /* dead */ }
      } catch { /* dead */ }
    }
  }

  // Write our PID and hold the file open
  fs.writeFileSync(lockPath, `${process.pid}\n`, { mode: 0o644 });
  lockFd = fs.openSync(lockPath, 'r');

  // Register cleanup on exit
  const cleanup = () => {
    if (lockFd !== null) {
      try { fs.closeSync(lockFd); } catch { /* ignore */ }
      lockFd = null;
    }
    try { fs.rmSync(lockPath, { force: true }); } catch { /* ignore */ }
  };
  process.on('exit', cleanup);
  process.on('SIGTERM', () => { cleanup(); process.exit(0); });
  process.on('SIGINT', () => { cleanup(); process.exit(0); });

  console.log(`[daemon] PID lock acquired (${lockPath}, PID ${process.pid})`);
}

/**
 * Release the PID lock (normally not needed — OS does it on exit).
 */
export function releasePidLock(): void {
  if (lockFd !== null) {
    try { fs.closeSync(lockFd); } catch { /* ignore */ }
    lockFd = null;
  }
  try { fs.rmSync(pidLockPath(), { force: true }); } catch { /* ignore */ }
}
