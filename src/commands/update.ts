/**
 * `shizuha update` — self-update the installed runtime (SCLI/operator directive
 * 2026-07-05: tailscale-style `curl -fsSL https://shizuha.com/install.sh | sh`
 * driven from inside the CLI, plus a daily availability check in the daemon).
 *
 * Update detection compares the release manifest's per-platform sha256 against
 * the sha recorded at install time (~/.shizuha/.installed-sha256). Version
 * strings alone are not sufficient: the release pipeline can republish the
 * same semver with new content, and older installs predate the marker.
 *
 * Source checkouts (repo with cli/src/) are developer installs — `git pull` +
 * rebuild is their update path; we refuse unless --force.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { detectInitSystem } from '../daemon/service.js';

const BUILDS_URL = process.env['SHIZUHA_BUILDS_URL'] ?? 'https://shizuha.com/builds/releases';
const INSTALLER_URL = process.env['SHIZUHA_INSTALLER_URL'] ?? 'https://shizuha.com/install.sh';

function shizuhaDir(): string {
  return process.env['SHIZUHA_DIR'] ?? path.join(process.env['HOME'] ?? os.homedir(), '.shizuha');
}

export function detectTarget(): string {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const plat = process.platform === 'darwin' ? 'darwin' : 'linux';
  return `${plat}-${arch}`;
}

/** True when this process runs from a source checkout rather than an installed tree. */
export function isSourceInstall(): boolean {
  try {
    // The marker is authoritative when present: a 'binary' install must not be
    // reclassified by the path heuristic (e.g. when the CLI is exercised from
    // a repo checkout against an installed SHIZUHA_DIR).
    const mode = fs.readFileSync(path.join(shizuhaDir(), 'INSTALL_MODE'), 'utf-8').trim();
    return mode === 'source';
  } catch { /* no marker — fall through to path heuristic */ }
  // Running from <repo>/dist/shizuha.js with a sibling src/ = source checkout.
  try {
    const here = path.dirname(new URL(import.meta.url).pathname);
    return fs.existsSync(path.join(here, '..', 'src')) && fs.existsSync(path.join(here, '..', 'package.json'));
  } catch {
    return false;
  }
}

export interface UpdateCheck {
  target: string;
  installedSha: string | null;
  installedVersion: string | null;
  latestSha: string | null;
  latestVersion: string | null;
  updateAvailable: boolean;
  reason: string;
}

/** Container/pod installs are immutable deployment artifacts. Updating their
 * writable layer is both ephemeral and a source of drift; Hive/the local
 * runtime manager owns those rollouts instead. */
export function isManagedRuntimeEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  exists: (file: string) => boolean = fs.existsSync,
): boolean {
  return Boolean(
    env['KUBERNETES_SERVICE_HOST']
    || env['SHIZUHA_MANAGED_RUNTIME'] === '1'
    || env['SHIZUHA_RUNTIME_ENVIRONMENT'] === 'container'
    || env['SHIZUHA_RUNTIME_ENVIRONMENT'] === 'k8s'
    || exists('/.dockerenv')
    || exists('/run/.containerenv')
  );
}

/** Host binary installs update automatically unless explicitly disabled.
 * Source trees and immutable container/pod runtimes retain their own update
 * mechanisms regardless of the environment override. */
export function automaticUpdatesEnabled(
  env: NodeJS.ProcessEnv = process.env,
  exists: (file: string) => boolean = fs.existsSync,
): boolean {
  if (env['SHIZUHA_AUTO_UPDATE'] === '0') return false;
  return !isManagedRuntimeEnvironment(env, exists);
}

export function readInstalledSha(): string | null {
  try {
    return fs.readFileSync(path.join(shizuhaDir(), '.installed-sha256'), 'utf-8').trim() || null;
  } catch {
    return null;
  }
}

export async function checkForUpdate(): Promise<UpdateCheck> {
  const target = detectTarget();
  const dir = shizuhaDir();
  let installedSha: string | null = null;
  let installedVersion: string | null = null;
  try { installedSha = fs.readFileSync(path.join(dir, '.installed-sha256'), 'utf-8').trim() || null; } catch { /* pre-marker install */ }
  try { installedVersion = fs.readFileSync(path.join(dir, 'VERSION'), 'utf-8').trim() || null; } catch { /* absent */ }

  const res = await fetch(`${BUILDS_URL}/latest.json`, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`manifest fetch failed: HTTP ${res.status}`);
  const manifest = await res.json() as {
    version?: string;
    platforms?: Record<string, { url?: string; sha256?: string }>;
  };
  const plat = manifest.platforms?.[target];
  const latestSha = plat?.sha256 ?? null;
  const latestVersion = manifest.version
    ?? (plat?.url ? (path.basename(plat.url).match(new RegExp(`^shizuha-(.*)-${target}\\.tar\\.gz$`))?.[1] ?? null) : null);

  let updateAvailable: boolean;
  let reason: string;
  if (!latestSha) {
    updateAvailable = false;
    reason = `no release published for platform ${target}`;
  } else if (!installedSha) {
    updateAvailable = true;
    reason = 'installed build has no sha marker (pre-marker install) — update to adopt the latest release';
  } else if (installedSha !== latestSha) {
    updateAvailable = true;
    reason = `installed sha ${installedSha.slice(0, 12)}… differs from latest ${latestSha.slice(0, 12)}…`;
  } else {
    updateAvailable = false;
    reason = 'already on the latest release';
  }
  return { target, installedSha, installedVersion, latestSha, latestVersion, updateAvailable, reason };
}

/** Download the official installer and execute it — the single, battle-tested
 *  install path (stops the daemon, moves the running tree aside, verifies
 *  sha256, restarts). Returns the installer's exit code. */
export async function runInstaller(options: { quiet?: boolean } = {}): Promise<number> {
  const res = await fetch(INSTALLER_URL, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`installer fetch failed: HTTP ${res.status} from ${INSTALLER_URL}`);
  const script = await res.text();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shizuha-update-'));
  const scriptPath = path.join(tmp, 'install.sh');
  fs.writeFileSync(scriptPath, script, { mode: 0o700 });
  return await new Promise<number>((resolve, reject) => {
    const child = spawn('bash', [scriptPath], {
      stdio: options.quiet ? 'ignore' : 'inherit',
      env: { ...process.env, SHIZUHA_DIR: shizuhaDir() },
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
      resolve(code ?? 1);
    });
  });
}

/** Schedule the installer outside the daemon's service cgroup. The installer
 * stops the current daemon while replacing its runtime, so a normal child
 * process would be killed midway through on systemd hosts. */
export async function scheduleInstaller(): Promise<void> {
  const res = await fetch(INSTALLER_URL, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`installer fetch failed: HTTP ${res.status} from ${INSTALLER_URL}`);
  const script = await res.text();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shizuha-update-'));
  const scriptPath = path.join(tmp, 'install.sh');
  const wrapperPath = path.join(tmp, 'run.sh');
  fs.writeFileSync(scriptPath, script, { mode: 0o700 });
  fs.writeFileSync(wrapperPath, `#!/usr/bin/env bash
set -o pipefail
trap 'rm -rf -- "$(dirname "$0")"' EXIT
exec 0</dev/null
bash "$(dirname "$0")/install.sh" >>"$SHIZUHA_DIR/update.log" 2>&1
`, { mode: 0o700 });

  try {
    if (detectInitSystem() === 'systemd') {
      const unit = `shizuha-self-update-${process.pid}-${Date.now()}`;
      const child = spawn('systemd-run', [
        '--user', '--quiet', '--collect', `--unit=${unit}`,
        `--setenv=SHIZUHA_DIR=${shizuhaDir()}`,
        'bash', wrapperPath,
      ], { stdio: 'ignore' });
      const code = await new Promise<number>((resolve, reject) => {
        child.on('error', reject);
        child.on('exit', (value) => resolve(value ?? 1));
      });
      if (code !== 0) throw new Error(`systemd-run exited with status ${code}`);
      return;
    }

    const child = spawn('bash', [wrapperPath], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, SHIZUHA_DIR: shizuhaDir() },
    });
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('spawn', () => {
        child.unref();
        resolve();
      });
    });
  } catch (err) {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
    throw err;
  }
}

export async function updateCommand(opts: { check?: boolean; force?: boolean }): Promise<number> {
  if (isSourceInstall() && !opts.force) {
    console.log('This is a source checkout — update with `git pull` + `npm run build`.');
    console.log('(Use `shizuha update --force` to overwrite ~/.shizuha with the released build anyway.)');
    return 1;
  }
  let check: UpdateCheck;
  try {
    check = await checkForUpdate();
  } catch (err) {
    console.error(`Update check failed: ${(err as Error).message}`);
    return 1;
  }
  console.log(`Platform: ${check.target}`);
  console.log(`Installed: v${check.installedVersion ?? '?'}${check.installedSha ? ` (${check.installedSha.slice(0, 12)}…)` : ' (no sha marker)'}`);
  console.log(`Latest:    v${check.latestVersion ?? '?'}${check.latestSha ? ` (${check.latestSha.slice(0, 12)}…)` : ''}`);
  console.log(check.updateAvailable ? `Update available — ${check.reason}` : check.reason);
  if (opts.check) return check.updateAvailable ? 10 : 0; // 10 = update available (scriptable)
  if (!check.updateAvailable && !opts.force) return 0;
  console.log('\nRunning installer…\n');
  return await runInstaller();
}
