/**
 * Daemon manager — orchestrates agent gateway processes.
 *
 * `shizuha up` flow:
 * 1. Authenticate with platform (read ~/.shizuha/auth.json)
 * 2. Discover agents via platform API
 * 3. Fork a detached daemon process that runs in background
 * 4. Parent prints summary and exits immediately
 *
 * Agents are discovered but NOT auto-started. They start on demand when:
 * - User sends a chat message to an agent (auto-activate)
 * - User explicitly enables an agent via the dashboard settings toggle
 *
 * Multi-device conflict resolution (WhatsApp "Use Here" model):
 * When a new runner connects for an agent that already has a runner,
 * the platform sends auth_pending. The new runner must explicitly choose
 * to evict (auth_confirm:evict) or run locally (auth_confirm:use_local).
 * No auto-eviction — requires user confirmation via the daemon/dashboard.
 */

import { fork, spawn, execSync, type ChildProcess } from 'node:child_process';
import * as dns from 'node:dns';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { logger } from '../utils/logger.js';
import { discoverClaudeTokens } from '../config/credentials.js';
import { buildBridgeIdentityPrompt } from '../prompt/bridge-identity.js';
import { PlatformClient } from './platform-client.js';
import { startDashboard } from './dashboard.js';
import {
  readDaemonState,
  writeDaemonState,
  clearDaemonState,
  isDaemonRunning,
  isShizuhaDaemonProcess,
  readEnabledAgents,
  writeEnabledAgents,
  readAgents,
  writeAgents,
  addAgent,
  removeAgent,
  updateAgentConfig,
  mergeRemoteAgents,
  acquirePidLock,
} from './state.js';
import type {
  AgentInfo,
  DaemonConfig,
  DaemonState,
  DaemonAgentState,
} from './types.js';
import { revokeAgentGatewayTokens } from './agent-auth.js';
import { startHttpsProxy, stopHttpsProxy, getHttpsProxyPort } from './https-proxy.js';

/** Load global TUI settings from ~/.shizuha/settings.json (reasoningEffort, thinkingLevel, etc.) */
function loadGlobalSettings(): { reasoningEffort?: string; thinkingLevel?: string } {
  try {
    const settingsPath = path.join(process.env['HOME'] ?? '~', '.shizuha', 'settings.json');
    const raw = fs.readFileSync(settingsPath, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      reasoningEffort: parsed.reasoningEffort as string | undefined,
      thinkingLevel: parsed.thinkingLevel as string | undefined,
    };
  } catch {
    return {};
  }
}

function isBridgePromptDebugEnabled(): boolean {
  return process.env['SHIZUHA_DEBUG_BRIDGE_PROMPTS'] === '1';
}

function summarizePromptForLog(prompt: string | null | undefined): Record<string, unknown> {
  const trimmed = prompt?.trim() ?? '';
  return {
    present: trimmed.length > 0,
    length: trimmed.length,
    hasIdentityHeader: trimmed.includes('## Shizuha Agent Identity'),
    firstLine: trimmed.split('\n')[0] ?? '',
  };
}

/** Resolve the full path to the docker binary. Caches result. */
let _dockerPath: string | null = null;
function resolveDockerPath(): string {
  if (_dockerPath) return _dockerPath;
  const candidates = [
    '/usr/local/bin/docker',
    '/opt/homebrew/bin/docker',
    '/usr/bin/docker',
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) { _dockerPath = p; return p; }
  }
  // Try PATH (works when PATH is properly set)
  try {
    const result = execSync('which docker', { encoding: 'utf-8', timeout: 3000 }).trim();
    if (result) { _dockerPath = result; return result; }
  } catch { /* not found */ }
  return 'docker'; // fallback to bare name
}

function getAgentWorkspaceDir(agent: AgentInfo): string {
  return path.join(process.env['HOME'] ?? '~', '.shizuha', 'workspaces', agent.username);
}

function getPrimaryExecutionMethod(agent: AgentInfo): string {
  return agent.modelFallbacks?.[0]?.method ?? agent.executionMethod ?? 'shizuha';
}

function isReadonlySqliteError(err: unknown): boolean {
  return /readonly database/i.test((err as Error)?.message ?? '');
}

export function resetSqliteSessionDatabase(dbPath: string, sessionId: string): void {
  if (!fs.existsSync(dbPath)) return;
  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath);
    const hasTable = (name: string): boolean =>
      !!db.prepare("SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name = ?").get(name);
    const tx = db.transaction(() => {
      if (hasTable('messages_fts')) db.prepare('DELETE FROM messages_fts WHERE session_id = ?').run(sessionId);
      if (hasTable('messages')) db.prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId);
      if (hasTable('session_interrupt_checkpoints')) {
        db.prepare('DELETE FROM session_interrupt_checkpoints WHERE session_id = ?').run(sessionId);
      }
      if (hasTable('sessions')) db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
    });
    tx();
  } catch (err) {
    try { db?.close(); } catch { /* ignore */ }
    db = null;
    if (isReadonlySqliteError(err)) {
      removeSqliteDatabaseFiles(dbPath);
      return;
    }
    throw err;
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

function removeSqliteDatabaseFiles(dbPath: string): void {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    fs.rmSync(`${dbPath}${suffix}`, { force: true });
  }
}

/** Check if Docker is available on this system. */
export function isDockerAvailable(): boolean {
  try {
    execSync(`${resolveDockerPath()} info`, { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/** Detect NVIDIA GPU (cached). */
let gpuDetected: boolean | null = null;
function hasNvidiaGpu(): boolean {
  if (gpuDetected !== null) return gpuDetected;
  try {
    execSync('nvidia-smi --query-gpu=name --format=csv,noheader', { stdio: 'pipe', timeout: 3000 });
    // Also check nvidia-container-toolkit
    const runtimes = execSync(`${resolveDockerPath()} info --format "{{json .Runtimes}}"`, { timeout: 5000 }).toString();
    gpuDetected = runtimes.includes('nvidia');
    if (gpuDetected) console.log('[daemon] NVIDIA GPU detected — containers will use --gpus all');
    return gpuDetected;
  } catch {
    gpuDetected = false;
    return false;
  }
}

/** Check if the Sysbox runtime is installed. */
export function isSysboxAvailable(): boolean {
  try {
    const output = execSync(`${resolveDockerPath()} info --format "{{json .Runtimes}}"`, { timeout: 5000 }).toString();
    return output.includes('sysbox-runc');
  } catch {
    return false;
  }
}

/** Resolve DinD mode: sysbox > privileged. Returns [enabled, mode]. */
export function resolveDindMode(): [boolean, 'sysbox' | 'privileged' | 'none'] {
  if (!isDockerAvailable()) return [false, 'none'];
  if (isSysboxAvailable()) return [true, 'sysbox'];
  // Fallback: privileged DinD (docker:dind pattern with --privileged)
  return [true, 'privileged'];
}

/**
 * Default agent container image — Ubuntu 24.04 with Node.js 22, common dev tools,
 * and everything agents need (CA certs, git, Python, build-essential, etc.).
 * Built once per daemon lifetime, cached locally. Multi-arch (amd64 + arm64).
 */
const AGENT_IMAGE = 'shizuha-agent-runtime:latest';
const AGENT_IMAGE_VERSION = '2'; // Bump to force rebuild
const AGENT_DOCKERFILE = `
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
ENV NODE_MAJOR=22

# ── Layer 1: System packages + Node.js 22 ──
RUN apt-get update && apt-get install -y --no-install-recommends \\
    ca-certificates curl gnupg git openssh-client \\
    python3 python3-pip python3-venv python3-dev \\
    build-essential pkg-config \\
    jq wget unzip tar gzip bzip2 xz-utils \\
    ripgrep fd-find tree less file procps htop \\
    sqlite3 libsqlite3-dev \\
    libffi-dev libssl-dev \\
    sudo lsb-release software-properties-common \\
  && mkdir -p /etc/apt/keyrings \\
  && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \\
  && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_\${NODE_MAJOR}.x nodistro main" > /etc/apt/sources.list.d/nodesource.list \\
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/etc/apt/keyrings/gh.gpg \\
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/gh.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \\
  && apt-get update && apt-get install -y --no-install-recommends nodejs gh \\
  && rm -rf /var/lib/apt/lists/*

# ── Layer 2: Python packages ──
RUN pip3 install --no-cache-dir --break-system-packages --ignore-installed \\
    pytest pytest-timeout pytest-asyncio pytest-django \\
    django djangorestframework django-cors-headers \\
    flask requests httpx aiohttp websockets \\
    sqlalchemy aiosqlite redis celery \\
    pydantic beautifulsoup4 lxml cryptography \\
    black ruff mypy pylint \\
    pyyaml toml python-dotenv \\
    Pillow numpy pandas

# ── Layer 3: Node.js global tools ──
RUN npm install -g @anthropic-ai/claude-code @openai/codex openclaw \\
    typescript tsx prettier eslint

# ── Layer 4: Convenience aliases ──
RUN ln -sf /usr/bin/fdfind /usr/local/bin/fd 2>/dev/null || true \\
  && ln -sf /usr/bin/python3 /usr/local/bin/python 2>/dev/null || true

# Non-root agent user (UID 1000 may already be taken by ubuntu user)
RUN existing_user=$(getent passwd 1000 | cut -d: -f1) \\
  && if [ -n "$existing_user" ] && [ "$existing_user" != "agent" ]; then \\
       usermod -l agent -d /home/agent -m "$existing_user" \\
       && groupmod -n agent "$existing_user" 2>/dev/null || true; \\
     elif [ -z "$existing_user" ]; then \\
       useradd -m -s /bin/bash -u 1000 agent; \\
     fi \\
  && echo "agent ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers.d/agent

WORKDIR /workspace
`.trim();

const DIND_IMAGE = 'shizuha-dind:latest';
const DIND_IMAGE_VERSION = '14'; // Bump to force rebuild (v14: Playwright-bundled Chromium + GPU)
const DIND_DOCKERFILE = `
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
ENV NODE_MAJOR=22

# ── Layer 1: System packages + Node.js + Docker ──
RUN apt-get update && apt-get install -y --no-install-recommends \\
    ca-certificates curl gnupg git openssh-client \\
    python3 python3-pip python3-venv python3-dev \\
    build-essential pkg-config \\
    jq wget unzip tar gzip bzip2 xz-utils \\
    ripgrep fd-find tree less file procps htop \\
    sqlite3 libsqlite3-dev \\
    libffi-dev libssl-dev \\
    sudo lsb-release software-properties-common \\
    tini \\
  && mkdir -p /etc/apt/keyrings \\
  && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \\
  && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_\${NODE_MAJOR}.x nodistro main" > /etc/apt/sources.list.d/nodesource.list \\
  && curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg \\
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu noble stable" > /etc/apt/sources.list.d/docker.list \\
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/etc/apt/keyrings/gh.gpg \\
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/gh.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \\
  && apt-get update && apt-get install -y --no-install-recommends \\
    nodejs gh docker-ce docker-ce-cli containerd.io docker-compose-plugin \\
  && rm -rf /var/lib/apt/lists/* \\
  && ARCH=$(dpkg --print-architecture) \\
  && RUNC_ARCH=$([ "$ARCH" = "amd64" ] && echo "amd64" || echo "arm64") \\
  && curl -fsSL "https://github.com/opencontainers/runc/releases/download/v1.1.15/runc.\${RUNC_ARCH}" -o /usr/bin/runc \\
  && chmod +x /usr/bin/runc

# ── Layer 2: Python packages ──
RUN pip3 install --no-cache-dir --break-system-packages --ignore-installed \\
    pytest pytest-timeout pytest-asyncio pytest-django \\
    django djangorestframework django-cors-headers \\
    flask requests httpx aiohttp websockets \\
    sqlalchemy aiosqlite redis celery \\
    pydantic beautifulsoup4 lxml cryptography \\
    black ruff mypy pylint \\
    pyyaml toml python-dotenv \\
    Pillow numpy pandas

# ── Layer 3: Chromium for CDP browser automation ──
# Ubuntu 24.04 ships chromium-browser as a snap stub — use Playwright's bundled Chromium instead.
# Install system deps that Chromium needs (shared libs).
RUN apt-get update && apt-get install -y --no-install-recommends \\
    fonts-liberation fonts-noto-color-emoji \\
    libgbm1 libnss3 libatk-bridge2.0-0 libdrm2 libxcomposite1 \\
    libxdamage1 libxrandr2 libcups2 libasound2t64 libpangocairo-1.0-0 \\
    libgtk-3-0 libxshmfence1 xvfb \\
  && rm -rf /var/lib/apt/lists/*

# ── Layer 4: Node.js global tools ──
RUN npm install -g @anthropic-ai/claude-code @openai/codex openclaw \\
    typescript tsx prettier eslint playwright \\
  && npx playwright install chromium --with-deps 2>/dev/null || true
ENV PLAYWRIGHT_BROWSERS_PATH=/root/.cache/ms-playwright

# ── Layer 4: Convenience aliases & config ──
RUN ln -sf /usr/libexec/docker/cli-plugins/docker-compose /usr/local/bin/docker-compose 2>/dev/null || true \\
  && ln -sf /usr/bin/fdfind /usr/local/bin/fd 2>/dev/null || true \\
  && ln -sf /usr/bin/python3 /usr/local/bin/python 2>/dev/null || true

# Non-root agent user (UID 1000 may already be taken by ubuntu user)
# Must be added to docker group so agent can access /var/run/docker.sock
RUN existing_user=$(getent passwd 1000 | cut -d: -f1) \\
  && if [ -n "$existing_user" ] && [ "$existing_user" != "agent" ]; then \\
       usermod -l agent -d /home/agent -m "$existing_user" \\
       && groupmod -n agent "$existing_user" 2>/dev/null || true; \\
     elif [ -z "$existing_user" ]; then \\
       useradd -m -s /bin/bash -u 1000 agent; \\
     fi \\
  && usermod -aG docker agent \\
  && echo "agent ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers.d/agent

COPY entrypoint.sh /usr/local/bin/dind-entrypoint.sh
RUN chmod +x /usr/local/bin/dind-entrypoint.sh
ENTRYPOINT ["/usr/local/bin/dind-entrypoint.sh"]
`.trim();

const DIND_ENTRYPOINT = `#!/bin/bash
set -euo pipefail

# ── Git identity & credential setup ──
# Configures git user, HTTPS credential helper, and gh CLI auth from env vars.
# AGENT_NAME, AGENT_EMAIL set by the daemon; GITHUB_TOKEN injected via credentials.
# Uses --system so config applies to ALL users (entrypoint runs as root, but
# the agent process runs as uid 1000 "agent" — --global would only set root's).
if [ -n "\${AGENT_NAME:-}" ]; then
  git config --system user.name "\${AGENT_NAME}"
  git config --system user.email "\${AGENT_EMAIL:-\${AGENT_USERNAME:-agent}@shizuha.com}"
  git config --system init.defaultBranch main
fi

# HTTPS credential helper: uses GITHUB_TOKEN for github.com, GITLAB_TOKEN for gitlab.com
if [ -n "\${GITHUB_TOKEN:-}" ]; then
  git config --system credential.https://github.com.helper '!f() { echo "username=x-access-token"; echo "password=\${GITHUB_TOKEN}"; }; f'
fi
if [ -n "\${GITLAB_TOKEN:-}" ]; then
  git config --system credential.https://gitlab.com.helper '!f() { echo "username=oauth2"; echo "password=\${GITLAB_TOKEN}"; }; f'
fi

# gh CLI auth (if gh is installed — pre-installed in DinD image)
if command -v gh &>/dev/null && [ -n "\${GITHUB_TOKEN:-}" ]; then
  echo "\${GITHUB_TOKEN}" | gh auth login --with-token 2>/dev/null || true
fi

# Start Docker daemon in the background if DinD is enabled
if [ "\${DIND_ENABLED:-1}" = "1" ]; then
  # Clean stale state from previous container runs. Overlay2 check directories
  # and metacopy test dirs become read-only artifacts when containers are killed
  # ungracefully, causing "read-only file system" errors on next dockerd start.
  rm -f /var/run/docker.pid /var/run/docker.sock 2>/dev/null || true
  rm -rf /var/lib/docker/network 2>/dev/null || true
  rm -rf /var/lib/docker/check-overlayfs-support* 2>/dev/null || true
  rm -rf /var/lib/docker/metacopy-check* 2>/dev/null || true

  # Write daemon config
  mkdir -p /etc/docker
  cat > /etc/docker/daemon.json <<'DJSON'
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "3" },
  "live-restore": true,
  "userland-proxy": false,
  "storage-driver": "overlay2"
}
DJSON

  echo "[dind] Starting Docker daemon..."
  dockerd > /tmp/dockerd.log 2>&1 &
  DOCKER_PID=$!

  # Wait for daemon (max 30s)
  waited=0
  while [ $waited -lt 30 ]; do
    if docker info > /dev/null 2>&1; then
      echo "[dind] Docker daemon ready after \${waited}s"
      break
    fi
    if ! kill -0 $DOCKER_PID 2>/dev/null; then
      echo "[dind] WARNING: dockerd exited (attempt 1). Cleaning state and retrying..."
      rm -rf /var/lib/docker/network /var/lib/docker/buildkit 2>/dev/null || true
      rm -rf /var/lib/docker/check-overlayfs-support* /var/lib/docker/metacopy-check* 2>/dev/null || true
      rm -f /var/run/docker.pid /var/run/docker.sock 2>/dev/null || true
      dockerd > /tmp/dockerd.log 2>&1 &
      DOCKER_PID=$!
      sleep 2
      if docker info > /dev/null 2>&1; then
        echo "[dind] Docker daemon ready (after cleanup retry)"
      else
        echo "[dind] WARNING: dockerd still failing. Log:"
        tail -10 /tmp/dockerd.log 2>/dev/null || true
        echo "[dind] Continuing without Docker..."
      fi
      break
    fi
    sleep 1
    waited=$((waited + 1))
  done

  if [ $waited -ge 30 ]; then
    echo "[dind] WARNING: Docker not ready in 30s, continuing without it"
  fi
fi

# Exec the command via tini (zombie reaper). On privileged DinD, Docker's --init
# already provides tini as PID 1; in that case /usr/bin/tini detects it's not PID 1
# and execs directly. On Sysbox (which has its own init), tini still reaps orphans
# from the bridge's subprocess tree (codex exec → docker-compose → containerd-shim).
exec /usr/bin/tini -- "$@"
`.trim();

/** Resolve hostnames to IPv4 and return --add-host docker args.
 * Rust HTTP clients (Codex CLI) don't fall back from IPv6 to IPv4,
 * so we pin DNS via /etc/hosts in the container. */
function resolveHostsIPv4(hostnames: string[]): string[] {
  const args: string[] = [];
  for (const hostname of hostnames) {
    try {
      const result = execSync(`dig +short A ${hostname} 2>/dev/null || getent ahostsv4 ${hostname} 2>/dev/null | head -1 | awk '{print $1}'`, {
        encoding: 'utf-8',
        timeout: 5000,
      }).trim();
      const ip = result.split('\n').find((line) => /^\d+\.\d+\.\d+\.\d+$/.test(line.trim()));
      if (ip) {
        args.push('--add-host', `${hostname}:${ip.trim()}`);
      }
    } catch {
      // DNS resolution failed — skip, container will use its own resolver
    }
  }
  return args;
}

/** Cache agent image build result so we only attempt once per daemon lifetime. */
let agentImageResult: boolean | null = null;


/** Ensure the shizuha-agent-runtime image is built. Returns true if available. */
export function ensureAgentImage(): boolean {
  if (agentImageResult !== null) return agentImageResult;
  const versionLabel = `shizuha.agent.version=${AGENT_IMAGE_VERSION}`;
  try {
    const inspectOut = execSync(
      `${resolveDockerPath()} image inspect --format '{{index .Config.Labels "shizuha.agent.version"}}' ${AGENT_IMAGE} 2>/dev/null`,
      { encoding: 'utf-8', timeout: 5000 },
    ).trim();
    if (inspectOut === AGENT_IMAGE_VERSION) { agentImageResult = true; return true; }
    console.log(`[daemon] Agent image version mismatch (have: ${inspectOut || 'none'}, want: ${AGENT_IMAGE_VERSION}). Rebuilding...`);
  } catch {
    // Image doesn't exist
  }

  console.log('[daemon] Building shizuha-agent-runtime image (this may take 5-10 min on first run)...');
  const buildDir = path.join(process.env['HOME'] ?? '~', '.shizuha', 'agent-build');
  fs.mkdirSync(buildDir, { recursive: true });
  const dockerfile = AGENT_DOCKERFILE + `\nLABEL shizuha.agent.version="${AGENT_IMAGE_VERSION}"`;
  fs.writeFileSync(path.join(buildDir, 'Dockerfile'), dockerfile);
  try {
    const buildEnv = { ...process.env };
    if (process.platform === 'darwin') {
      const extraPaths = [
        '/Applications/Docker.app/Contents/Resources/bin',
        '/usr/local/bin', '/opt/homebrew/bin',
        path.join(process.env['HOME'] ?? '', '.docker/bin'),
      ];
      buildEnv['PATH'] = [...extraPaths, buildEnv['PATH'] ?? ''].join(':');
    }
    execSync(resolveDockerPath() + ' build -t ' + AGENT_IMAGE + ' ' + buildDir, {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 900_000, // 15 min (larger image)
      env: buildEnv,
    });
    console.log('[daemon] shizuha-agent-runtime image built successfully');
    agentImageResult = true;
    return true;
  } catch (err) {
    console.error('[daemon] Failed to build agent image: ' + (err as Error).message);
    console.log('[daemon] Falling back to node:22 (full Debian) image');
    agentImageResult = false;
    return false;
  }
}

/** Cache DinD build result so we only attempt once per daemon lifetime. */
let dindBuildResult: boolean | null = null;

/** Ensure the shizuha-dind Docker image is built. Returns true if available. */
export function ensureDindImage(): boolean {
  if (dindBuildResult !== null) return dindBuildResult;
  // Use a version label to detect when the Dockerfile changes and needs rebuild
  const versionLabel = `shizuha.dind.version=${DIND_IMAGE_VERSION}`;
  try {
    // Check if image exists WITH the correct version label
    const inspectOut = execSync(
      `${resolveDockerPath()} image inspect --format '{{index .Config.Labels "shizuha.dind.version"}}' ${DIND_IMAGE} 2>/dev/null`,
      { encoding: 'utf-8', timeout: 5000 },
    ).trim();
    if (inspectOut === DIND_IMAGE_VERSION) { dindBuildResult = true; return true; }
    // Image exists but version mismatch — rebuild
    console.log(`[daemon] DinD image version mismatch (have: ${inspectOut || 'none'}, want: ${DIND_IMAGE_VERSION}). Rebuilding...`);
  } catch {
    // Image doesn't exist at all
  }

  // Build the image
  console.log('[daemon] Building shizuha-dind image (this may take 2-5 min on first run)...');
  const buildDir = path.join(process.env['HOME'] ?? '~', '.shizuha', 'dind-build');
  fs.mkdirSync(buildDir, { recursive: true });
  // Append version label to Dockerfile
  const dockerfile = DIND_DOCKERFILE + `\nLABEL shizuha.dind.version="${DIND_IMAGE_VERSION}"`;
  fs.writeFileSync(path.join(buildDir, 'Dockerfile'), dockerfile);
  fs.writeFileSync(path.join(buildDir, 'entrypoint.sh'), DIND_ENTRYPOINT);
  try {
    // On macOS, Docker Desktop's credential helpers live outside the default
    // PATH (which is minimal under launchd). Extend PATH so docker build can
    // find docker-credential-desktop/osxkeychain when resolving base images.
    const buildEnv = { ...process.env };
    if (process.platform === 'darwin') {
      const extraPaths = [
        '/Applications/Docker.app/Contents/Resources/bin',
        '/usr/local/bin',
        '/opt/homebrew/bin',
        path.join(process.env['HOME'] ?? '', '.docker/bin'),
      ];
      buildEnv['PATH'] = [...extraPaths, buildEnv['PATH'] ?? ''].join(':');
    }
    execSync(resolveDockerPath() + ' build -t ' + DIND_IMAGE + ' ' + buildDir, {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 600_000, // 10 min (larger image now)
      env: buildEnv,
    });
    console.log('[daemon] shizuha-dind image built successfully');
    dindBuildResult = true;
    return true;
  } catch (err) {
    console.error('[daemon] Failed to build shizuha-dind image: ' + (err as Error).message);
    dindBuildResult = false;
    return false;
  }
}

/** Seed agents for first-run — written to agents.json once, then user owns it */
function seedDefaultAgents(): AgentInfo[] {
  const runtime = isDockerAvailable() ? 'container' : 'bare_metal';
  return [
    {
      id: 'local-claude',
      name: 'Claude',
      username: 'claude',
      email: 'claude@local',
      role: 'engineer',
      status: 'active',
      localPort: 8018,
      executionMethod: 'claude_code_server',
      runtimeEnvironment: runtime as AgentInfo['runtimeEnvironment'],
      modelFallbacks: [
        { method: 'claude_code_server', model: 'claude-opus-4-6', thinkingLevel: 'on', reasoningEffort: 'max' },
      ],
      mcpServers: [],
      personalityTraits: { style: 'thorough' },
      skills: ['coding', 'debugging', 'architecture', 'review'],
    },
    {
      id: 'local-shizuha',
      name: 'Shizuha',
      username: 'shizuha',
      email: 'shizuha@local',
      role: 'engineer',
      status: 'active',
      localPort: 8017,
      executionMethod: 'shizuha',
      runtimeEnvironment: runtime as AgentInfo['runtimeEnvironment'],
      modelFallbacks: [
        { method: 'shizuha', model: 'gpt-5.4-xhigh', reasoningEffort: 'xhigh' },
      ],
      mcpServers: [],
      personalityTraits: { style: 'pragmatic' },
      skills: ['coding', 'debugging', 'devops'],
    },
    {
      id: 'local-codex',
      name: 'Codex',
      username: 'codex',
      email: 'codex@local',
      role: 'engineer',
      status: 'active',
      localPort: 8019,
      executionMethod: 'codex_app_server',
      runtimeEnvironment: runtime as AgentInfo['runtimeEnvironment'],
      modelFallbacks: [
        { method: 'codex_app_server', model: 'gpt-5.4-xhigh', reasoningEffort: 'xhigh' },
      ],
      mcpServers: [],
      personalityTraits: { style: 'pragmatic' },
      skills: ['coding', 'debugging', 'devops', 'testing'],
    },
  ];
}

/** Token cache for agents (stored in memory, persisted for respawn) */
const tokenCache = new Map<string, string>();

/** Running child processes indexed by agent ID */
const childProcesses = new Map<string, ChildProcess>();

/** Whether the daemon is shutting down */
let shuttingDown = false;

/** In-memory daemon state — single source of truth (avoids file race conditions) */
let inMemoryState: DaemonState | null = null;

/** Discovered agents — available for on-demand start */
let discoveredAgents: AgentInfo[] = [];

/** Daemon config — needed for starting agents later */
let daemonConfig: DaemonConfig | null = null;

/** Platform client — for token management */
let platformClient: PlatformClient | null = null;

/** Callback for agent state changes — set by the dashboard to push updates to WS clients. */
let onAgentStateChange: ((agentId: string) => void) | null = null;

/** Register a callback for agent state changes (called by dashboard). */
export function setAgentStateChangeListener(cb: (agentId: string) => void): void {
  onAgentStateChange = cb;
}

/** Update an agent's state in memory and persist to disk */
function updateAgentInMemory(agentId: string, update: Partial<DaemonAgentState>): void {
  if (!inMemoryState) return;
  const idx = inMemoryState.agents.findIndex((a) => a.agentId === agentId);
  if (idx >= 0) {
    inMemoryState.agents[idx] = { ...inMemoryState.agents[idx]!, ...update };
  }
  writeDaemonState(inMemoryState);
  // Notify dashboard so it can push the update to WS clients
  onAgentStateChange?.(agentId);
}

/** Log file path */
function daemonLogPath(): string {
  return path.join(process.env['HOME'] ?? '~', '.shizuha', 'daemon.log');
}

/**
 * Start the daemon — discovers agents, forks background process, exits.
 */
export async function startDaemon(
  config: DaemonConfig,
  accessToken: string,
): Promise<void> {
  // Safety check — caller (shizuha up) should have already stopped any
  // existing daemon, but guard against direct programmatic calls.
  if (process.env['SHIZUHA_DAEMON'] !== '1' && isDaemonRunning()) {
    console.log('Stopping existing daemon...');
    stopDaemon();
  }

  // ── Load agents: local file is source of truth, platform sync appends new ones ──

  let agents = readAgents();

  // First run: seed with default agents
  if (agents.length === 0) {
    agents = seedDefaultAgents();
    writeAgents(agents);
    console.log(`First run — created ${agents.length} default agents (${agents.map(a => a.name).join(', ')}).`);
  }

  // If linked to platform, sync: append any new platform agents we don't have yet
  if (accessToken) {
    const client = new PlatformClient(config.platformUrl, accessToken);
    console.log(`Syncing agents from ${config.platformUrl}...`);

    try {
      const remoteAgents = await client.discoverAgents();
      const added = mergeRemoteAgents(remoteAgents);
      // Always re-read after merge — mergeRemoteAgents updates existing agents too
      agents = readAgents();
      if (added > 0) {
        console.log(`Synced ${added} new agent(s) from platform.`);
      } else {
        console.log('Agent sync complete — all agents up to date.');
      }
    } catch (err) {
      console.warn(`Platform unavailable: ${(err as Error).message}`);
      console.log('Using cached agents from ~/.shizuha/agents.json');
    }
  } else {
    console.log('No platform login — using local agents.');
  }

  // Filter agents if specific ones requested
  if (config.agentFilter.length > 0 && agents.length > 0) {
    const filter = config.agentFilter.map((f) => f.toLowerCase());
    agents = agents.filter(
      (a) =>
        filter.includes(a.name.toLowerCase()) ||
        filter.includes(a.username.toLowerCase()) ||
        filter.includes(a.id),
    );

    if (agents.length === 0) {
      console.error(
        `No agents match filter: ${config.agentFilter.join(', ')}`,
      );
      process.exit(1);
    }
  }

  // If we're the forked daemon process or --foreground, run directly
  if (process.env['SHIZUHA_DAEMON'] === '1' || config.foreground) {
    await runDaemon(config, accessToken, agents);
    return;
  }

  // ---- Foreground: fork the daemon and exit ----

  if (agents.length > 0) {
    console.log(`Found ${agents.length} agent(s):`);
    for (const agent of agents) {
      const agentDir = path.join(process.env['HOME'] ?? '~', '.shizuha', 'agents', agent.username);
      const configSource = fs.existsSync(path.join(agentDir, 'agent.toml')) ? 'local' : 'platform';
      console.log(`  ${agent.name} (${agent.username}) — config: ${configSource}`);
    }
  } else {
    console.log('No agents discovered. Dashboard will start in standalone mode.');
  }
  console.log('');

  // Ensure log directory exists
  const logDir = path.dirname(daemonLogPath());
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
  }

  // Open log file for daemon stdout/stderr
  const logFd = fs.openSync(daemonLogPath(), 'a');

  // Fork a detached daemon process
  const shizuhaJs = process.argv[1]!;
  const daemonArgs = process.argv.slice(2); // pass same args
  const daemon = spawn(process.execPath, [shizuhaJs, ...daemonArgs], {
    detached: true,
    stdio: ['ignore', logFd, logFd, 'ignore'],
    env: {
      ...process.env,
      SHIZUHA_DAEMON: '1',
      SHIZUHA_ACCESS_TOKEN: accessToken,
    },
  });

  // Write preliminary state so `shizuha status` works immediately
  // Agents default to disabled (not started) unless explicitly filtered
  const autoEnable = config.agentFilter.length > 0;
  const daemonState: DaemonState = {
    pid: daemon.pid!,
    startedAt: new Date().toISOString(),
    platformUrl: config.platformUrl,
    agents: agents.map((a) => ({
      agentId: a.id,
      agentName: a.name,
      tokenPrefix: '',
      status: autoEnable ? 'starting' as const : 'stopped' as const,
      enabled: autoEnable,
      startedAt: new Date().toISOString(),
    })),
  };
  writeDaemonState(daemonState);

  // Detach — daemon continues after parent exits
  daemon.unref();
  fs.closeSync(logFd);

  console.log(`Daemon started (PID ${daemon.pid})`);
  console.log(`  Logs: ${daemonLogPath()}`);
  console.log(`  Dashboard: http://localhost:8015/`);
  console.log('');
  console.log(`Use "shizuha status" to check status, "shizuha down" to stop.`);
}

/**
 * The actual daemon loop — runs in the detached background process.
 *
 * Agents are registered but only started if explicitly filtered via CLI
 * or enabled later via dashboard API.
 */
async function runDaemon(
  config: DaemonConfig,
  accessToken: string,
  agents: AgentInfo[],
): Promise<void> {
  const client = new PlatformClient(config.platformUrl, accessToken);
  platformClient = client;
  daemonConfig = config;
  discoveredAgents = agents;

  console.log(`[daemon] Starting (PID ${process.pid}), ${agents.length} agents discovered`);

  // Acquire exclusive PID lock — kills any existing daemon (installed or dev)
  acquirePidLock();

  // Start HTTPS CONNECT proxy for agent containers.
  // Rust HTTP clients (Codex CLI) fail with IPv6 DNS in Docker — this proxy
  // runs on the host (Node.js handles IPv4 fallback) and containers route
  // through it via HTTPS_PROXY env var.
  if (isDockerAvailable()) {
    try {
      const proxyPort = await startHttpsProxy();
      console.log(`[daemon] HTTPS proxy started on port ${proxyPort} (for container IPv6 workaround)`);
    } catch (err) {
      console.warn(`[daemon] Failed to start HTTPS proxy: ${(err as Error).message} — containers may have connectivity issues`);
    }
  }

  // Assign local ports to all agents that don't have one — all agents are local.
  // Also reassign ports that are already taken by other processes (e.g., VS Code port forwarding).
  for (const agent of agents) {
    if (!agent.localPort) {
      agent.localPort = nextLocalPort();
    } else if (!isPortAvailable(agent.localPort)) {
      const oldPort = agent.localPort;
      agent.localPort = nextLocalPort();
      console.log(`[daemon] Port ${oldPort} in use — reassigned ${agent.name} to port ${agent.localPort}`);
    }
  }

  // Update state with our real PID (may differ from parent's estimate)
  // Restore persisted enabled state, or use CLI filter for first-time setup
  const persistedEnabled = readEnabledAgents();
  const cliFilter = config.agentFilter.length > 0;

  const daemonState: DaemonState = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    platformUrl: config.platformUrl,
    agents: agents.map((a) => ({
      agentId: a.id,
      agentName: a.name,
      tokenPrefix: '',
      status: 'stopped' as const,
      enabled: cliFilter || persistedEnabled.has(a.id),
      startedAt: new Date().toISOString(),
    })),
  };
  inMemoryState = daemonState;
  writeDaemonState(daemonState);

  // Start the dashboard server — HTTP on 8015, HTTPS on 8016 (if cert available)
  let tls: { cert: string; key: string } | undefined;
  try {
    const { ensureTlsCert } = await import('./tls.js');
    tls = ensureTlsCert();
  } catch {
    // TLS cert generation failed — HTTP only
  }
  try {
    await startDashboard({
      port: 8015,
      host: '0.0.0.0',
      platformUrl: config.platformUrl,
      accessToken,
      agents,
      tls,
    });
    console.log(`[daemon] Dashboard listening on :8015 (${tls ? 'HTTPS' : 'HTTP'})${tls ? ' + :8016 (HTTP)' : ''}`);
  } catch (err) {
    console.error(`[daemon] Dashboard failed: ${(err as Error).message}`);
  }

  // Auto-start agents that are enabled (from persisted state or CLI filter).
  // Bring the dashboard up first so clients see a live daemon immediately
  // during restart, even while runtimes are still booting.
  const toStart = daemonState.agents.filter((a) => a.enabled);
  for (const agentState of toStart) {
    const agent = agents.find((a) => a.id === agentState.agentId);
    if (agent) {
      await enableAndStartAgent(agent.id);
    }
  }

  // Graceful shutdown
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('[daemon] Shutting down...');
    stopAllAgents();
    stopHttpsProxy();
    clearDaemonState();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  const enabledCount = toStart.length;
  console.log(`[daemon] Running. ${agents.length} agents discovered, ${enabledCount} enabled.`);

  // Heartbeat
  setInterval(() => {
    const running = Array.from(childProcesses.entries()).filter(
      ([, cp]) => !cp.killed && cp.exitCode === null,
    );
    logger.debug({ running: running.length, total: agents.length }, 'Daemon heartbeat');
  }, 60_000);
}

/**
 * Enable and start a single agent's runtime.
 * Gets/creates runner token, starts gateway subprocess.
 * If already running, no-op.
 */
export async function enableAndStartAgent(agentId: string): Promise<{ ok: boolean; error?: string }> {
  if (!inMemoryState || !daemonConfig) {
    return { ok: false, error: 'Daemon not initialized' };
  }

  // Check if already running
  if (childProcesses.has(agentId)) {
    updateAgentInMemory(agentId, { enabled: true });
    return { ok: true };
  }

  const agent = discoveredAgents.find((a) => a.id === agentId);
  if (!agent) {
    return { ok: false, error: 'Agent not found' };
  }

  // All agents run locally. Optionally get a platform runner token for
  // cross-device message relay (best-effort, not required for execution).
  let platformRunnerToken = '';

  if (platformClient) {
    try {
      const tokenResult = await platformClient.ensureRunnerToken(agentId);
      if (!tokenResult.token) {
        await platformClient.revokeRunnerToken(tokenResult.id);
        const freshToken = await platformClient.createRunnerToken(agentId);
        platformRunnerToken = freshToken.token ?? '';
      } else {
        platformRunnerToken = tokenResult.token;
      }
      if (platformRunnerToken) {
        tokenCache.set(agentId, platformRunnerToken);
        console.log(`[daemon] ${agent.name}: obtained platform runner token for relay`);
      }
    } catch (err) {
      console.log(`[daemon] ${agent.name}: platform relay unavailable — ${(err as Error).message}`);
    }
  }

  updateAgentInMemory(agentId, {
    status: 'starting',
    enabled: true,
    tokenPrefix: platformRunnerToken ? platformRunnerToken.slice(0, 8) : 'local',
    startedAt: new Date().toISOString(),
  });

  const enabled = readEnabledAgents();
  enabled.add(agentId);
  writeEnabledAgents(enabled);

  startAgentProcess(agent, platformRunnerToken, daemonConfig);
  return { ok: true };
}

/**
 * Disable and stop a single agent's runtime.
 * Kills the gateway subprocess.
 */
export function disableAndStopAgent(agentId: string): { ok: boolean; error?: string } {
  if (!inMemoryState) {
    return { ok: false, error: 'Daemon not initialized' };
  }

  revokeAgentGatewayTokens(agentId);

  const child = childProcesses.get(agentId);
  if (child) {
    child.kill('SIGTERM');
    childProcesses.delete(agentId);

    // Force kill after 5s
    setTimeout(() => {
      if (!child.killed && child.exitCode === null) {
        child.kill('SIGKILL');
      }
    }, 5000);
  }

  updateAgentInMemory(agentId, {
    status: 'stopped',
    enabled: false,
    pid: undefined,
  });

  // Persist disabled state so it survives daemon restarts
  const enabled = readEnabledAgents();
  enabled.delete(agentId);
  writeEnabledAgents(enabled);

  const agent = discoveredAgents.find((a) => a.id === agentId);
  console.log(`[daemon] ${agent?.name ?? agentId}: disabled`);

  return { ok: true };
}

/**
 * Restart an agent by killing its process while keeping it enabled.
 * The exit handler's auto-restart logic will bring it back with updated config.
 */
export function restartAgent(agentId: string): void {
  const agent = discoveredAgents.find((a) => a.id === agentId);
  const runtime = agent?.runtimeEnvironment ?? 'bare_metal';

  if (runtime === 'container' || runtime === 'restricted_container' || runtime === 'sandbox') {
    // For containers: `docker rm -f` is the reliable way to stop them.
    // Sending SIGTERM to the `docker run` process only forwards SIGTERM to PID 1
    // inside the container — if PID 1 catches it and hangs, the container stays alive.
    const containerName = `shizuha-agent-${agent?.username ?? agentId}`;
    try {
      execSync(`${resolveDockerPath()} rm -f ${containerName} 2>/dev/null`, { stdio: 'ignore', timeout: 15_000 });
    } catch { /* ignore — container may already be gone */ }
  } else {
    // Bare-metal: SIGTERM the process directly
    const child = childProcesses.get(agentId);
    if (child) {
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!child.killed && child.exitCode === null) {
          child.kill('SIGKILL');
        }
      }, 5000);
    }
  }
}

/**
 * Clear an agent's durable runtime session so the next start resumes from a fresh state.
 * This is intentionally narrow: remove only the runtime's session artifact, not the whole workspace.
 */
export function resetAgentRuntimeSession(agentId: string): { ok: boolean; error?: string } {
  const agent = discoveredAgents.find((a) => a.id === agentId || a.username === agentId);
  if (!agent) {
    return { ok: false, error: 'Agent not found' };
  }

  const workspaceDir = getAgentWorkspaceDir(agent);
  const method = getPrimaryExecutionMethod(agent);

  try {
    // Clear all known per-agent runtime state so reset remains correct even if
    // an agent changed execution methods over time.
    resetSqliteSessionDatabase(path.join(workspaceDir, '.shizuha-state.db'), `agent-session-${agent.id}`);
    resetSqliteSessionDatabase(path.join(workspaceDir, '.codex-state.db'), `codex-bridge-${agent.id}`);
    // OpenClaw state files may be owned by root inside the workspace even though
    // the workspace directory itself is writable by the daemon user. Removing the
    // per-agent database files is more reliable than mutating the live DB in place.
    removeSqliteDatabaseFiles(path.join(workspaceDir, '.openclaw-state.db'));
    fs.rmSync(path.join(workspaceDir, '.claude-session-id'), { force: true });

    switch (method) {
      case 'shizuha': {
        return { ok: true };
      }
      case 'codex_app_server': {
        return { ok: true };
      }
      case 'openclaw_bridge': {
        return { ok: true };
      }
      case 'claude_code_server': {
        return { ok: true };
      }
      default:
        return { ok: false, error: `Runtime session reset is not supported for method "${method}"` };
    }
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/**
 * Check if an agent runtime is currently running.
 */
export function isAgentRunning(agentId: string): boolean {
  const child = childProcesses.get(agentId);
  return !!child && !child.killed && child.exitCode === null;
}

/**
 * Get the local port for a local agent (if running).
 */
export function getLocalAgentPort(agentId: string): number | null {
  const agent = discoveredAgents.find((a) => a.id === agentId);
  if (!agent) return null;
  return agent.localPort ?? null;
}

/**
 * Start a single agent as a gateway subprocess.
 *
 * Config resolution:
 * - If the agent has a local ~/.shizuha/agents/{username}/agent.toml,
 *   the gateway loads all runtime config from there (model, thinking, etc.).
 *   Platform model_overrides are NOT passed — local config takes priority.
 * - If no local config exists, platform model_overrides are passed as --model
 *   fallback so the gateway has something to work with.
 * - Same logic for context_prompt vs CLAUDE.md.
 */
function startAgentProcess(
  agent: AgentInfo,
  token: string,
  config: DaemonConfig,
): void {
  // Resolve symlinks so container mount paths match the real filesystem layout.
  // e.g. ~/.shizuha/lib/shizuha.js → /real/path/dist/shizuha.js
  const shizuhaJs = fs.realpathSync(process.argv[1]!);
  const agentDir = path.join(process.env['HOME'] ?? '~', '.shizuha', 'agents', agent.username);
  const hasLocalConfig = fs.existsSync(path.join(agentDir, 'agent.toml'));
  const hasLocalClaudeMd = fs.existsSync(path.join(agentDir, 'CLAUDE.md'));

  // Determine execution command based on method
  const primaryMethod = agent.modelFallbacks?.[0]?.method ?? 'shizuha';
  const useClaudeBridge = primaryMethod === 'claude_code_server';
  const useCodexBridge = primaryMethod === 'codex_app_server';
  const useOpenClawBridge = primaryMethod === 'openclaw_bridge';
  const isBridgeMode = useClaudeBridge || useCodexBridge || useOpenClawBridge;

  // Model-method constraint: prevent mismatched models from being used with wrong execution methods.
  // Claude Code CLI only supports Anthropic models (claude-*). Codex only supports OpenAI models (gpt-*).
  const primaryModel = agent.modelFallbacks?.[0]?.model ?? '';
  if (useClaudeBridge && primaryModel && !primaryModel.startsWith('claude') && !primaryModel.startsWith('opus') && !primaryModel.startsWith('sonnet') && !primaryModel.startsWith('haiku')) {
    console.warn(`[daemon] ${agent.name}: WARNING — claude_code_server requires a Claude model (got "${primaryModel}"). Auto-correcting to claude-sonnet-4-6.`);
    if (agent.modelFallbacks?.[0]) agent.modelFallbacks[0].model = 'claude-sonnet-4-6';
  }
  if (useCodexBridge && primaryModel && !primaryModel.startsWith('gpt') && !primaryModel.startsWith('codex') && !primaryModel.startsWith('o3') && !primaryModel.startsWith('o4')) {
    console.warn(`[daemon] ${agent.name}: WARNING — codex_app_server requires an OpenAI model (got "${primaryModel}"). Auto-correcting to gpt-5.3-codex-spark.`);
    if (agent.modelFallbacks?.[0]) {
      agent.modelFallbacks[0].model = 'gpt-5.3-codex-spark';
      agent.modelFallbacks[0].reasoningEffort = 'xhigh';
    }
  }
  const command = useClaudeBridge ? 'claude-bridge'
    : useCodexBridge ? 'codex-bridge'
    : useOpenClawBridge ? 'openclaw-bridge'
    : 'gateway';

  const args = [
    command,
    '--agent-id', agent.id,
    '--agent-name', agent.name,
    '--agent-username', agent.username,
    '--port', String(agent.localPort ?? 0),
  ];

  // gateway-only flags
  if (!isBridgeMode) {
    args.push('--mode', 'autonomous');
  }

  // Connect to platform WS as runner — enables message relay/fanout.
  // Works for both platform agents and local agents with a platform counterpart.
  // (Only for gateway mode — bridges don't have --connect support)
  if (token && !isBridgeMode) {
    let connectUrl = config.wsUrl;
    const runtime = agent.runtimeEnvironment ?? 'bare_metal';
    if (runtime === 'container' || runtime === 'restricted_container') {
      // Inside Docker, 127.0.0.1/localhost refers to the container itself.
      // Replace with host.docker.internal so the container can reach the host.
      connectUrl = connectUrl.replace(/\/\/(127\.0\.0\.1|localhost)([:\/])/,  '//host.docker.internal$2');
    }
    args.push('--connect', connectUrl, '--connect-token', token);
  }

  if (!hasLocalConfig) {
    // No local config — fall back to platform configuration
    if (agent.modelFallbacks?.length) {
      // New: ordered fallback chain — pass primary as --model, full chain as env
      const primary = agent.modelFallbacks[0]!;
      args.push('--model', primary.model);
    } else if (agent.modelOverrides) {
      // Legacy: single execution_method + model_overrides map
      const modelOverride = (agent.executionMethod ? agent.modelOverrides[agent.executionMethod] : '')
        || agent.modelOverrides['shizuha']
        || '';
      if (modelOverride) {
        args.push('--model', modelOverride);
      }
    }

    // Reasoning effort: primary model chain entry → global settings → omit (provider default)
    const globalSettings = loadGlobalSettings();
    const effort = agent.modelFallbacks?.[0]?.reasoningEffort ?? globalSettings.reasoningEffort;
    if (effort) {
      args.push('--effort', effort);
    }

    // Thinking level: primary model chain entry → global settings → omit (provider default)
    // Only relevant for claude-bridge and gateway (Codex doesn't have a thinking flag)
    if (!useCodexBridge) {
      const thinking = agent.modelFallbacks?.[0]?.thinkingLevel ?? globalSettings.thinkingLevel;
      if (thinking) {
        args.push('--thinking', thinking);
      }
    }
  }

  if (isBridgeMode) {
    let bridgeCustomPrompt: string | null = null;
    let bridgePromptSource: 'local-claude-md' | 'agent-context' | 'none' = 'none';
    if (hasLocalClaudeMd) {
      try {
        bridgeCustomPrompt = fs.readFileSync(path.join(agentDir, 'CLAUDE.md'), 'utf-8');
        bridgePromptSource = 'local-claude-md';
      } catch (err) {
        console.warn(`[daemon] ${agent.name}: failed to read local CLAUDE.md for bridge prompt: ${(err as Error).message}`);
      }
    } else {
      bridgeCustomPrompt = agent.contextPrompt ?? null;
      if (bridgeCustomPrompt) bridgePromptSource = 'agent-context';
    }
    const bridgeIdentityPrompt = buildBridgeIdentityPrompt(agent, bridgeCustomPrompt);
    console.log(
      `[daemon] ${agent.name}: bridge prompt source=${bridgePromptSource} summary=${JSON.stringify(summarizePromptForLog(bridgeIdentityPrompt))}`,
    );
    if (isBridgePromptDebugEnabled()) {
      console.log(`[daemon] ${agent.name}: bridge prompt begin\n${bridgeIdentityPrompt}\n[daemon] ${agent.name}: bridge prompt end`);
    }
    args.push('--context-prompt', bridgeIdentityPrompt);
  } else if (!hasLocalClaudeMd && agent.contextPrompt) {
    args.push('--context-prompt', agent.contextPrompt);
  }

  const runtime = agent.runtimeEnvironment ?? 'bare_metal';
  console.log(`[daemon] Starting ${agent.name} (runtime: ${runtime})...`);

  // Build credential env vars from agent credentials
  const credentialEnv: Record<string, string> = {};
  if (agent.credentials?.length) {
    for (const cred of agent.credentials) {
      if (!cred.isActive || !cred.injectAsEnv) continue;
      if (cred.envMapping) {
        // Explicit mapping: credentialData key → env var name
        for (const [dataKey, envName] of Object.entries(cred.envMapping)) {
          const val = cred.credentialData[dataKey];
          if (val) credentialEnv[envName] = val;
        }
      } else {
        // Default: inject credentialData keys as env vars directly (uppercased)
        for (const [key, val] of Object.entries(cred.credentialData)) {
          if (val) credentialEnv[key.toUpperCase()] = val;
        }
      }
    }
  }

  // For claude_code_server agents: inject Claude OAuth token so Claude Code inside
  // the container can authenticate. The container doesn't have access to ~/.claude/.credentials.json
  // because ~/.shizuha/claude-sessions/ is mounted over /home/agent/.claude/.
  // Check both the resolved primary method AND the declared executionMethod.
  const needsClaudeToken = useClaudeBridge || agent.executionMethod === 'claude_code_server';
  if (needsClaudeToken && !credentialEnv['CLAUDE_CODE_OAUTH_TOKEN']) {
    try {
      const tokens = discoverClaudeTokens();
      if (tokens.length > 0) {
        credentialEnv['CLAUDE_CODE_OAUTH_TOKEN'] = tokens[0]!.token;
        console.log(`[daemon] ${agent.name}: injecting Claude OAuth token (${tokens[0]!.label})`);
      } else {
        // No token available — don't start the agent, mark as auth error
        // so the dashboard shows the token input card immediately
        console.warn(`[daemon] ${agent.name}: no Claude OAuth token found — skipping start`);
        updateAgentInMemory(agent.id, {
          status: 'error',
          error: 'no Claude OAuth token found',
        });
        return;
      }
    } catch (e) {
      console.error(`[daemon] ${agent.name}: failed to discover Claude tokens: ${(e as Error).message}`);
    }
  }

  const agentEnv = {
    ...process.env,
    SHIZUHA_AGENT_TOKEN: token,
    AGENT_ID: agent.id,
    AGENT_USERNAME: agent.username,
    DAEMON_HOST: '127.0.0.1', // bare_metal — daemon is local
    DAEMON_PORT: '8015',
    ...credentialEnv,
    ...(agent.modelFallbacks?.length ? { SHIZUHA_MODEL_FALLBACKS: JSON.stringify(agent.modelFallbacks) } : {}),
  };

  let child: ChildProcess;

  if (runtime === 'container' || runtime === 'restricted_container' || runtime === 'sandbox') {
    // ── Container mode: spawn inside Docker ──
    const containerName = `shizuha-agent-${agent.username}`;
    const shizuhaDir = path.dirname(shizuhaJs); // dir containing shizuha.js
    const shizuhaRoot = path.dirname(shizuhaDir); // project root (parent of dist/)
    const shizuhaHome = process.env['HOME'] ?? path.resolve(os.homedir());
    const port = String(agent.localPort ?? 0);
    const containerShizuha = '/opt/shizuha';

    // ── Resolve Docker-in-Docker mode ──
    // Sysbox: best isolation (nested Docker with overlay2, no --privileged)
    // Privileged: DinD with --privileged (overlay2 works, less isolated)
    // None: no inner Docker daemon (Ubuntu agent image or node:22 fallback)
    const [dindEnabled, dindMode] = resolveDindMode();
    const useDind = dindEnabled && runtime === 'container'; // DinD only for standard container, not restricted/sandbox
    const hasDindImage = useDind ? ensureDindImage() : false;

    // Image priority: DinD image > shizuha-agent-runtime (Ubuntu) > node:22 (Debian, fallback)
    // node:22 is the full Debian bookworm image (not slim) — includes ca-certificates, git, etc.
    let containerImage: string;
    if (hasDindImage) {
      containerImage = DIND_IMAGE;
    } else {
      const hasAgentImage = ensureAgentImage();
      containerImage = hasAgentImage ? AGENT_IMAGE : 'node:22';
    }

    if (useDind && hasDindImage) {
      console.log(`[daemon] ${agent.name}: DinD mode=${dindMode} (image=${containerImage})`);
    } else {
      console.log(`[daemon] ${agent.name}: image=${containerImage}`);
    }

    const dockerArgs = [
      'run', '--rm',
      '--name', containerName,
      '--add-host', 'host.docker.internal:host-gateway',
      // Disable IPv6 inside container — many Docker networks lack IPv6 connectivity
      // but DNS returns AAAA records first, causing Rust HTTP clients (e.g. Codex CLI)
      // to fail without falling back to IPv4.
      '--sysctl', 'net.ipv6.conf.all.disable_ipv6=1',
      // Force chatgpt.com to resolve via IPv4 — the Codex CLI's Rust HTTP client
      // doesn't fall back from IPv6 to IPv4, so we pin the DNS via /etc/hosts.
      ...resolveHostsIPv4(['chatgpt.com', 'api.openai.com']),
      '-p', `${port}:${port}`,
      // Mount project root (dist/ + node_modules/ for external deps)
      '-v', `${shizuhaRoot}:${containerShizuha}:ro`,
      // Writable workspace
      '-v', `${shizuhaHome}/.shizuha/workspaces/${agent.username}:/workspace`,
      // Persistent Claude Code session storage (transcripts survive container restarts)
      '-v', `${shizuhaHome}/.shizuha/claude-sessions/${agent.username}:/home/agent/.claude`,
      // Mount agent config dir if it exists
      ...(fs.existsSync(agentDir) ? ['-v', `${agentDir}:/root/.shizuha/agents/${agent.username}:ro`] : []),
      // Mount skills repo for search_skills/use_skill (read-only)
      // Use /opt/skills (NOT /opt/shizuha/skills) to avoid conflict with :ro parent mount
      ...(fs.existsSync(path.join(shizuhaHome, '.shizuha', 'skills'))
        ? ['-v', `${shizuhaHome}/.shizuha/skills:/opt/skills:ro`] : []),
      // Mount plugins directory (read-only — plugins can write to workspace, not plugin dir)
      ...(fs.existsSync(path.join(shizuhaHome, '.shizuha', 'plugins'))
        ? ['-v', `${shizuhaHome}/.shizuha/plugins:/root/.shizuha/plugins:ro`] : []),
      // Mount credentials for API access
      ...(fs.existsSync(path.join(shizuhaHome, '.shizuha', 'credentials.json'))
        ? ['-v', `${shizuhaHome}/.shizuha/credentials.json:/root/.shizuha/credentials.json:ro`] : []),
      // Mount shared codex auth directory (writable) so all containers share one
      // auth.json. The Codex CLI's read-before-refresh guard prevents token races
      // when multiple containers refresh concurrently — it re-reads from disk before
      // refreshing and skips if another instance already wrote new tokens.
      // Seed from host ~/.codex/auth.json on first run.
      ...(() => {
        const sharedCodexDir = path.join(shizuhaHome, '.shizuha', 'codex-auth');
        const sharedAuthFile = path.join(sharedCodexDir, 'auth.json');
        const hostAuthFile = path.join(shizuhaHome, '.codex', 'auth.json');
        fs.mkdirSync(sharedCodexDir, { recursive: true });
        // Seed from host if shared copy doesn't exist or is empty
        if (!fs.existsSync(sharedAuthFile) || fs.statSync(sharedAuthFile).size === 0) {
          if (fs.existsSync(hostAuthFile)) {
            fs.copyFileSync(hostAuthFile, sharedAuthFile);
          }
        }
        return fs.existsSync(sharedAuthFile)
          ? ['-v', `${sharedCodexDir}:/home/agent/.codex`]
          : [];
      })(),
      // Working directory: /workspace is writable (mounted above); /opt/shizuha is :ro
      '-w', '/workspace',
      // Environment
      '-e', `SHIZUHA_AGENT_TOKEN=${token}`,
      '-e', 'SHIZUHA_GATEWAY_LOCALHOST_BYPASS=1',
      '-e', `DIND_ENABLED=${useDind && hasDindImage ? '1' : '0'}`,
      // Agent identity for git config
      '-e', `AGENT_ID=${agent.id}`,
      '-e', `AGENT_NAME=${agent.name}`,
      '-e', `AGENT_EMAIL=${agent.email ?? (agent.username + '@shizuha.com')}`,
      '-e', `AGENT_USERNAME=${agent.username}`,
      '-e', 'DAEMON_HOST=host.docker.internal',
      '-e', 'DAEMON_PORT=8015',
      ...(agent.modelFallbacks?.length ? ['-e', `SHIZUHA_MODEL_FALLBACKS=${JSON.stringify(agent.modelFallbacks)}`] : []),
      // Inject credential env vars into container
      ...Object.entries(credentialEnv).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
      // HTTPS proxy — route container HTTPS traffic through host's Node.js proxy.
      // Solves IPv6 DNS issues: Rust HTTP clients (Codex CLI reqwest) fail when
      // Docker DNS returns AAAA records but container lacks IPv6. The proxy runs
      // on the host (Node.js handles IPv4 fallback) and tunnels via CONNECT.
      ...(getHttpsProxyPort() > 0 ? [
        '-e', `HTTPS_PROXY=http://host.docker.internal:${getHttpsProxyPort()}`,
        '-e', `HTTP_PROXY=http://host.docker.internal:${getHttpsProxyPort()}`,
        '-e', `https_proxy=http://host.docker.internal:${getHttpsProxyPort()}`,
        '-e', `http_proxy=http://host.docker.internal:${getHttpsProxyPort()}`,
      ] : []),
      ...(process.env['SHIZUHA_DEBUG_BRIDGE_PROMPTS']
        ? ['-e', `SHIZUHA_DEBUG_BRIDGE_PROMPTS=${process.env['SHIZUHA_DEBUG_BRIDGE_PROMPTS']}`]
        : []),
    ];

    // ── DinD: Docker-in-Docker support ──
    if (useDind && hasDindImage) {
      if (dindMode === 'sysbox') {
        // Sysbox: true nested containers, no --privileged needed
        dockerArgs.push('--runtime=sysbox-runc');
      } else {
        // Privileged DinD: needed for dockerd inside the container
        dockerArgs.push('--privileged');
        // tini as init: reap zombie processes from codex exec → docker-compose → containerd-shim.
        // Without this, orphaned grandchildren reparent to PID 1 (Node.js) which doesn't
        // call waitpid() on processes it didn't spawn, causing zombie accumulation that
        // eventually stalls the event loop and kills the WS server.
        // Sysbox has its own init, so only add for privileged mode.
        dockerArgs.push('--init');
      }
      // Ephemeral Docker storage via tmpfs — gives clean overlay2 state on every start.
      // Bind mounts accumulated stale overlay2 check-overlayfs-support*/metacopy-check*
      // directories that could not be removed (read-only overlay work dirs), forcing
      // fallback to vfs which can't unpack images with /proc (Lchown permission denied).
      // tmpfs avoids this entirely: fresh overlay2 every time, images re-pulled as needed.
      dockerArgs.push('--tmpfs', '/var/lib/docker:exec');
    } else {
      // No DinD: set entrypoint to node directly (skip dind-entrypoint.sh)
      dockerArgs.push('--entrypoint', 'node');
    }

    // ── Cross-platform native module support ──
    // When the host is macOS but containers are Linux, native modules (better-sqlite3)
    // compiled for macOS (Mach-O) won't load in Linux containers (needs ELF).
    // If a pre-built node_modules-linux/ directory exists (built via Docker during deploy),
    // mount it over the macOS node_modules so the container gets Linux-native binaries.
    const isCrossPlatform = process.platform === 'darwin';
    if (isCrossPlatform) {
      const linuxNmPath = path.join(shizuhaDir, 'node_modules-linux');
      if (fs.existsSync(linuxNmPath)) {
        const nmContainerPath = `${containerShizuha}/${path.basename(shizuhaDir)}/node_modules`;
        dockerArgs.push('-v', `${linuxNmPath}:${nmContainerPath}:ro`);
      } else {
        console.log(`[daemon] WARNING: ${agent.name}: cross-platform (macOS→Linux) but no node_modules-linux/ found.`);
        console.log(`[daemon]   Native modules compiled for macOS won't load in Linux containers.`);
        console.log(`[daemon]   Run: mkdir -p ${shizuhaDir}/node_modules-linux && docker run --rm -v ${shizuhaDir}:/mnt/lib:ro -v ${shizuhaDir}/node_modules-linux:/mnt/out -w /tmp node:22 sh -c 'cp /mnt/lib/package*.json . && npm install --production && cp -a node_modules/. /mnt/out/'`);
      }
    }

    // ── GPU passthrough for Chromium/browser and ML workloads ──
    // Detect NVIDIA GPU and mount into container for accelerated rendering.
    // Requires: nvidia-container-toolkit installed on host, `nvidia` Docker runtime.
    if (hasNvidiaGpu()) {
      dockerArgs.push('--gpus', 'all');
      dockerArgs.push('-e', 'NVIDIA_VISIBLE_DEVICES=all');
      dockerArgs.push('-e', 'NVIDIA_DRIVER_CAPABILITIES=compute,utility,graphics');
    }

    // User-configured resource limits
    const limits = agent.resourceLimits;
    if (limits?.memory) dockerArgs.push('--memory', limits.memory);
    if (limits?.cpus) dockerArgs.push('--cpus', limits.cpus);
    if (limits?.pidsLimit) dockerArgs.push('--pids-limit', String(limits.pidsLimit));

    // Restricted container: add security constraints (no DinD)
    if (runtime === 'restricted_container') {
      dockerArgs.push('--cap-drop=ALL', '--security-opt=no-new-privileges');
      if (!limits?.pidsLimit) dockerArgs.push('--pids-limit=256');
    }
    // Sandbox: no network, read-only root fs (no DinD)
    if (runtime === 'sandbox') {
      dockerArgs.push(
        '--cap-drop=ALL', '--security-opt=no-new-privileges',
        '--network=none', '--read-only', '--tmpfs=/tmp:rw,noexec,nosuid,size=256m',
      );
      if (!limits?.pidsLimit) dockerArgs.push('--pids-limit=128');
    }

    // Image + command — resolve the relative path of shizuha.js within the project root
    // Dev layout: shizuhaRoot/dist/shizuha.js → relPath = "dist/shizuha.js"
    // Installed layout: shizuhaRoot/lib/shizuha.js → relPath = "lib/shizuha.js"
    const relPath = path.relative(shizuhaRoot, shizuhaJs);
    const containerShizuhaJs = `${containerShizuha}/${relPath}`;
    if (useDind && hasDindImage) {
      // DinD image: entrypoint is dind-entrypoint.sh, command is node + args
      dockerArgs.push(containerImage, 'node', containerShizuhaJs, ...args);
    } else {
      // Same-platform, plain node image: entrypoint is node, command is shizuha.js + args
      dockerArgs.push(containerImage, containerShizuhaJs, ...args);
    }

    if (isBridgeMode) {
      console.log(
        `[daemon] ${agent.name}: bridge container launch image=${containerImage} summary=${JSON.stringify({
          useDind: useDind && hasDindImage,
          command,
          containerShizuhaJs,
          argv: (useDind && hasDindImage ? ['node', containerShizuhaJs, ...args] : [containerShizuhaJs, ...args]),
          contextPrompt: summarizePromptForLog(args[args.indexOf('--context-prompt') + 1]),
        })}`,
      );
    }

    // Kill any existing container with the same name
    try {
      execSync(`${resolveDockerPath()} rm -f ${containerName} 2>/dev/null`, { stdio: 'ignore' });
    } catch { /* ignore */ }

    // Ensure workspace and claude session dirs exist
    const workspaceDir = path.join(shizuhaHome, '.shizuha', 'workspaces', agent.username);
    const claudeSessionDir = path.join(shizuhaHome, '.shizuha', 'claude-sessions', agent.username);
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.mkdirSync(claudeSessionDir, { recursive: true });

    child = spawn(resolveDockerPath(), dockerArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
  } else {
    // ── Bare metal: fork directly ──
    // Ensure workspace directory exists (launchd starts with cwd=/ which is not writable)
    const bareMetalCwd = path.join(process.env['HOME'] ?? os.homedir(), '.shizuha', 'workspaces', agent.username);
    fs.mkdirSync(bareMetalCwd, { recursive: true });
    child = fork(shizuhaJs, args, {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      cwd: bareMetalCwd,
      env: agentEnv,
    });
  }

  childProcesses.set(agent.id, child);

  child.stdout?.on('data', (data: Buffer) => {
    const line = data.toString().trim();
    if (line) {
      console.log(`  [${agent.name}] ${line}`);
    }
  });

  // Capture stderr to extract real error messages (e.g., "Codex not authenticated")
  let lastStderrLine = '';
  child.stderr?.on('data', (data: Buffer) => {
    const text = data.toString().trim();
    if (text) {
      // Log only a truncated version to daemon log (avoid flooding with minified source)
      const logLines = text.split('\n').filter((l) => l.length < 500);
      if (logLines.length) console.error(`  [${agent.name}] ${logLines.join('\n  ')}`);

      // Extract clean error messages from stderr
      // Node.js prints source context before the error — skip long lines (minified bundles)
      for (const line of text.split('\n')) {
        if (line.length > 500) continue; // Skip minified source context lines
        // Match "Error: <message>" or "TypeError: <message>" etc.
        const errorMatch = line.match(/(?:^|\s)((?:\w+)?Error):\s*(.+)/);
        if (errorMatch) {
          lastStderrLine = errorMatch[2].replace(/\s+at\s+.*$/, '').trim();
          break;
        }
        // Known error keywords
        if (line.includes('not authenticated') || line.includes('not configured')) {
          lastStderrLine = line.trim();
          break;
        }
      }
    }
  });

  child.on('exit', (code, signal) => {
    // Ignore exit events from stale child processes (a new one may have already
    // been spawned via enableAndStartAgent while this one was still stopping).
    const currentChild = childProcesses.get(agent.id);
    if (currentChild && currentChild !== child) {
      // A newer process is already tracked — this is a stale exit event.
      return;
    }
    childProcesses.delete(agent.id);

    if (shuttingDown) return;

    // Check if agent is still enabled (user may have toggled it off)
    const agentState = inMemoryState?.agents.find((a) => a.agentId === agent.id);
    if (!agentState?.enabled) {
      updateAgentInMemory(agent.id, { status: 'stopped' });
      return;
    }

    if (code !== 0) {
      const errorMsg = lastStderrLine || `Exited with code ${code}`;
      console.error(
        `  [${agent.name}] exited with code ${code} (signal: ${signal}): ${errorMsg}`,
      );
      updateAgentInMemory(agent.id, {
        status: 'error',
        error: errorMsg,
      });

      // Don't auto-restart on auth errors — user needs to configure credentials
      if (errorMsg.includes('not authenticated') || errorMsg.includes('not configured')) {
        console.log(`  [${agent.name}] Auth required — skipping auto-restart`);
        return;
      }

      // Auto-restart after 5 seconds (only if still enabled and no newer process started)
      console.log(`  [${agent.name}] Restarting in 5s...`);
      setTimeout(() => {
        const currentState = inMemoryState?.agents.find((a) => a.agentId === agent.id);
        if (!shuttingDown && currentState?.enabled && !childProcesses.has(agent.id)) {
          startAgentProcess(agent, tokenCache.get(agent.id) ?? '', config);
        }
      }, 5000);
    } else {
      // Clean exit (code 0) — restart if still enabled. Agents should run 24/7.
      // Clean exits happen on SIGTERM (daemon restart), container OOM, or
      // gateway shutdown. The agent should always come back.
      updateAgentInMemory(agent.id, { status: 'stopped' });
      console.log(`  [${agent.name}] Clean exit — restarting in 5s...`);
      setTimeout(() => {
        const currentState = inMemoryState?.agents.find((a) => a.agentId === agent.id);
        if (!shuttingDown && currentState?.enabled && !childProcesses.has(agent.id)) {
          startAgentProcess(agent, tokenCache.get(agent.id) ?? '', config);
        }
      }, 5000);
    }
  });

  child.on('spawn', () => {
    updateAgentInMemory(agent.id, {
      status: 'running',
      pid: child.pid,
    });
    console.log(`  [${agent.name}] running (PID ${child.pid})`);
  });

  child.on('error', (err) => {
    console.error(`  [${agent.name}] spawn error: ${err.message}`);
    updateAgentInMemory(agent.id, {
      status: 'error',
      error: err.message,
    });
  });
}

/**
 * Stop all running agent processes.
 */
function stopAllAgents(): void {
  for (const [agentId, child] of childProcesses) {
    console.log(`  Stopping agent ${agentId} (PID ${child.pid})...`);
    child.kill('SIGTERM');
  }

  // Give processes 5 seconds to exit gracefully
  setTimeout(() => {
    for (const [agentId, child] of childProcesses) {
      if (!child.killed && child.exitCode === null) {
        console.log(`  Force-killing agent ${agentId} (PID ${child.pid})...`);
        child.kill('SIGKILL');
      }
    }
  }, 5000);
}

/**
 * Stop the daemon and all agents.
 * Checks both the PID lock file and daemon.json state to find running daemons.
 */
export function stopDaemon(): boolean {
  const { readPidLock, releasePidLock } = require('./state.js') as typeof import('./state.js');
  let killed = false;

  // Check PID lock file (authoritative — written by acquirePidLock)
  const lockPid = readPidLock();
  if (lockPid && isShizuhaDaemonProcess(lockPid)) {
    try {
      process.kill(lockPid, 'SIGTERM');
      console.log(`Sent shutdown signal to daemon (PID ${lockPid} from lock file).`);
      killed = true;
    } catch { /* not running */ }
  }

  // Also check daemon.json state (may have a different PID)
  const state = readDaemonState();
  if (state && state.pid !== lockPid) {
    if (isShizuhaDaemonProcess(state.pid)) {
      try {
        process.kill(state.pid, 'SIGTERM');
        console.log(`Sent shutdown signal to daemon (PID ${state.pid} from state).`);
        killed = true;
      } catch { /* not running */ }
    }
  }

  if (!killed) {
    console.log('No daemon is running.');
  }

  clearDaemonState();
  releasePidLock();
  return killed;
}

/**
 * Show daemon status.
 */
export async function showStatus(
  platformUrl?: string,
  accessToken?: string,
): Promise<void> {
  const state = readDaemonState();

  if (state) {
    let alive = false;
    try {
      process.kill(state.pid, 0);
      alive = true;
    } catch {
      // stale state
    }

    console.log(`Daemon: ${alive ? 'running' : 'not running (stale)'}`);
    console.log(`  PID: ${state.pid}`);
    console.log(`  Started: ${state.startedAt}`);
    console.log(`  Platform: ${state.platformUrl}`);
    console.log(`  Agents: ${state.agents.length}`);
    console.log(`  Logs: ${daemonLogPath()}`);
    console.log('');

    for (const agent of state.agents) {
      const statusIcon =
        agent.status === 'running'
          ? '+'
          : agent.status === 'error'
            ? 'x'
            : '-';
      const enabledTag = agent.enabled ? '' : ' [disabled]';
      console.log(
        `  [${statusIcon}] ${agent.agentName} (${agent.status})${enabledTag}${agent.pid ? ` PID ${agent.pid}` : ''}`,
      );
      if (agent.error) {
        console.log(`      Error: ${agent.error}`);
      }
    }
  } else {
    console.log('Daemon: not running');
  }

  // If we have platform access, also show connected runners
  if (platformUrl && accessToken) {
    console.log('');
    const client = new PlatformClient(platformUrl, accessToken);
    try {
      const runners = await client.getRunnerStatus();
      if (runners.length > 0) {
        console.log('Connected runners (platform view):');
        for (const r of runners) {
          const ago = Math.round((Date.now() / 1000 - r.connectedAt) / 60);
          console.log(
            `  ${r.agentName} — token ${r.tokenPrefix}... (connected ${ago}m ago, v${r.runnerVersion})`,
          );
        }
      } else {
        console.log('No runners currently connected to the platform.');
      }
    } catch (err) {
      console.log(`Unable to query platform: ${(err as Error).message}`);
    }
  }
}

// ── Runtime agent CRUD (for dashboard) ──

/** Check if a port is available (not in use by another process). */
function isPortAvailable(port: number): boolean {
  try {
    // Use lsof/ss to check if port is in use — works synchronously
    if (process.platform === 'darwin') {
      execSync(`lsof -i :${port} -sTCP:LISTEN`, { stdio: 'ignore', timeout: 3000 });
      return false; // lsof succeeded = something is listening
    } else {
      execSync(`ss -tlnp sport = :${port} | grep -q LISTEN`, { stdio: 'ignore', timeout: 3000 });
      return false;
    }
  } catch {
    return true; // command failed = nothing listening = port available
  }
}

/** Find the next available local port for a new agent. */
function nextLocalPort(): number {
  const usedPorts = discoveredAgents
    .filter((a) => a.localPort)
    .map((a) => a.localPort!);
  let port = 8018; // 8017 is default local agent
  while (usedPorts.includes(port) || !isPortAvailable(port)) port++;
  return port;
}

/**
 * Create a new local agent at runtime. Persists to agents.json,
 * adds to in-memory state, and optionally starts it.
 */
export function createLocalAgentAtRuntime(info: {
  name: string;
  username: string;
  email?: string;
  role?: string;
  executionMethod?: string;
  skills?: string[];
  personalityTraits?: Record<string, string>;
  modelFallbacks?: Array<{ method: string; model: string }>;
}): AgentInfo {
  const id = `local-${info.username}-${Date.now().toString(36)}`;
  const port = nextLocalPort();

  const agent: AgentInfo = {
    id,
    name: info.name,
    username: info.username,
    email: info.email || `${info.username}@local`,
    role: info.role || 'agent',
    status: 'active',
    localPort: port,
    executionMethod: info.executionMethod || 'shizuha',
    runtimeEnvironment: (isDockerAvailable() ? 'container' : 'bare_metal') as AgentInfo['runtimeEnvironment'],
    modelFallbacks: info.modelFallbacks,
    mcpServers: [],
    personalityTraits: info.personalityTraits || {},
    skills: info.skills || [],
  };

  // Persist to disk
  addAgent(agent);

  // Add to in-memory lists
  discoveredAgents.push(agent);

  // Add to daemon state (stopped by default)
  if (inMemoryState) {
    inMemoryState.agents.push({
      agentId: agent.id,
      agentName: agent.name,
      tokenPrefix: '',
      status: 'stopped',
      enabled: false,
      startedAt: new Date().toISOString(),
    });
    writeDaemonState(inMemoryState);
  }

  console.log(`[daemon] Created local agent: ${agent.name} (@${agent.username}) [${agent.id}]`);
  return agent;
}

/**
 * Delete a local agent at runtime. Stops it if running, removes from
 * in-memory state and agents.json.
 */
export function deleteLocalAgentAtRuntime(agentId: string): { ok: boolean; error?: string } {
  const agent = discoveredAgents.find((a) => a.id === agentId);
  if (!agent) {
    return { ok: false, error: 'Agent not found' };
  }
  // Stop if running
  const child = childProcesses.get(agentId);
  if (child && !child.killed) {
    child.kill('SIGTERM');
    childProcesses.delete(agentId);
  }

  // Remove from in-memory
  discoveredAgents = discoveredAgents.filter((a) => a.id !== agentId);
  if (inMemoryState) {
    inMemoryState.agents = inMemoryState.agents.filter((a) => a.agentId !== agentId);
    writeDaemonState(inMemoryState);
  }

  // Remove from enabled set
  const enabled = readEnabledAgents();
  enabled.delete(agentId);
  writeEnabledAgents(enabled);

  // Remove from persisted agents
  removeAgent(agentId);

  console.log(`[daemon] Deleted local agent: ${agent.name} (@${agent.username}) [${agentId}]`);
  return { ok: true };
}

/**
 * Update a local agent's configuration at runtime.
 */
export function updateLocalAgentAtRuntime(agentId: string, updates: Record<string, unknown>): { ok: boolean; error?: string } {
  const agent = discoveredAgents.find((a) => a.id === agentId);
  if (!agent) {
    return { ok: false, error: 'Agent not found' };
  }
  // Validate runtime environment switch
  if (updates.runtime_environment != null) {
    const target = updates.runtime_environment as string;
    if ((target === 'container' || target === 'restricted_container' || target === 'sandbox') && !isDockerAvailable()) {
      return { ok: false, error: 'Docker is not installed or not accessible. Install Docker and ensure the current user has access before switching to container mode.' };
    }
  }

  // Apply updates to in-memory agent
  if (updates.name != null) agent.name = updates.name as string;
  if (updates.username != null) agent.username = updates.username as string;
  if (updates.email != null) agent.email = updates.email as string;
  if (updates.role != null) agent.role = updates.role as string | null;
  if (updates.execution_method != null) agent.executionMethod = updates.execution_method as string;
  if (updates.runtime_environment != null) agent.runtimeEnvironment = updates.runtime_environment as AgentInfo['runtimeEnvironment'];
  if (updates.skills != null) agent.skills = updates.skills as string[];
  if (updates.personality_traits != null) agent.personalityTraits = updates.personality_traits as Record<string, string>;
  if (updates.model_fallbacks != null) agent.modelFallbacks = updates.model_fallbacks as AgentInfo['modelFallbacks'];
  if (updates.model_overrides != null) agent.modelOverrides = updates.model_overrides as Record<string, string>;
  if (updates.context_prompt != null) agent.contextPrompt = updates.context_prompt as string;
  if (updates.resource_limits != null) agent.resourceLimits = updates.resource_limits as AgentInfo['resourceLimits'];
  // Platform-aligned fields
  if (updates.agent_memory != null) agent.agentMemory = updates.agent_memory as string;
  if (updates.work_schedule != null) agent.workSchedule = updates.work_schedule as AgentInfo['workSchedule'];
  if (updates.token_budget != null) agent.tokenBudget = updates.token_budget as AgentInfo['tokenBudget'];
  if (updates.max_concurrent_tasks != null) agent.maxConcurrentTasks = updates.max_concurrent_tasks as number;
  if (updates.allow_parallel_execution != null) agent.allowParallelExecution = updates.allow_parallel_execution as boolean;
  if (updates.warm_pool_size != null) agent.warmPoolSize = updates.warm_pool_size as number;
  if (updates.tier != null) agent.tier = updates.tier as AgentInfo['tier'];
  if (updates.credentials != null) agent.credentials = updates.credentials as AgentInfo['credentials'];

  // Persist
  updateAgentConfig(agentId, agent);

  // Update daemon state name if changed
  if (inMemoryState && updates.name != null) {
    const ds = inMemoryState.agents.find((a) => a.agentId === agentId);
    if (ds) ds.agentName = updates.name as string;
    writeDaemonState(inMemoryState);
  }

  // Restart agent if settings that affect the runtime changed.
  // These include: runtime environment, model chain (model/effort/thinking), context prompt.
  const needsRestart = updates.runtime_environment != null
    || updates.model_fallbacks != null
    || updates.model_overrides != null
    || updates.execution_method != null
    || updates.context_prompt != null;

  if (needsRestart) {
    const child = childProcesses.get(agentId);
    if (child && !child.killed) {
      const reason = updates.runtime_environment != null ? 'runtime environment'
        : updates.model_fallbacks != null ? 'model chain'
        : updates.context_prompt != null ? 'context prompt'
        : 'execution settings';
      console.log(`[daemon] ${reason} changed — restarting ${agent.name}...`);
      // Kill Docker container if present
      const containerName = `shizuha-agent-${agent.username}`;
      try {
        execSync(`${resolveDockerPath()} rm -f ${containerName} 2>/dev/null`, { stdio: 'ignore' });
      } catch { /* ignore */ }
      child.kill('SIGTERM');
      // The exit handler will auto-restart since the agent is still enabled
    }
  }

  return { ok: true };
}
