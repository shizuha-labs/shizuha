/**
 * systemd user service management for shizuha daemon.
 *
 * `shizuha up` installs and starts a systemd user service so the daemon:
 *   - Auto-starts on boot (via loginctl enable-linger)
 *   - Auto-restarts on crash (Restart=on-failure)
 *   - Is managed like any system service (journalctl, systemctl)
 *
 * Mirrors how tailscale works — `tailscale up` configures & starts,
 * `tailscale down` stops, the service persists across reboots.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';

const SERVICE_NAME = 'shizuha';
const UNIT_FILE = `${SERVICE_NAME}.service`;

function serviceDir(): string {
  return path.join(process.env['HOME'] ?? '~', '.config', 'systemd', 'user');
}

function serviceFilePath(): string {
  return path.join(serviceDir(), UNIT_FILE);
}

/** Check if systemd user services are available on this system. */
export function hasSystemd(): boolean {
  try {
    execSync('systemctl --user --version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Check if the shizuha service is installed. */
export function isServiceInstalled(): boolean {
  return fs.existsSync(serviceFilePath());
}

/** Check if the shizuha service is currently running. */
export function isServiceRunning(): boolean {
  try {
    const result = execSync(`systemctl --user is-active ${SERVICE_NAME}`, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return result === 'active';
  } catch {
    return false;
  }
}

/**
 * Generate the systemd unit file content.
 *
 * The service runs `shizuha up --foreground` which handles auth,
 * agent discovery, and the main daemon loop. Auth tokens are read
 * from ~/.shizuha/auth.json (not baked into the service file).
 */
function generateUnit(shizuhaParts: string[], extraArgs: string[]): string {
  const execStart = [...shizuhaParts, 'up', '--foreground', ...extraArgs]
    .map((a) => (a.includes(' ') ? `"${a}"` : a))
    .join(' ');

  return `[Unit]
Description=Shizuha Agent Runtime
Documentation=https://github.com/shizuha/shizuha
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${execStart}
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production
Environment=PATH=${process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin'}
Environment=HOME=${process.env['HOME'] ?? '~'}

# Logging — use journalctl -u shizuha --user
StandardOutput=journal
StandardError=journal
SyslogIdentifier=shizuha

# Graceful shutdown
TimeoutStopSec=15
KillMode=mixed
KillSignal=SIGTERM

[Install]
WantedBy=default.target
`;
}

export interface InstallServiceOptions {
  /** Extra CLI args to pass to `shizuha up --foreground` (e.g., --platform, --agent) */
  extraArgs?: string[];
}

/**
 * Install (or update) and start the shizuha systemd user service.
 *
 * Steps:
 *   1. Write the unit file to ~/.config/systemd/user/
 *   2. daemon-reload
 *   3. enable (auto-start on boot)
 *   4. restart (start or restart if already running)
 *   5. enable-linger (so user services run without active login session)
 */
export function installAndStartService(opts: InstallServiceOptions = {}): void {
  const shizuhaParts = resolveShizuhaPath();
  const extraArgs = opts.extraArgs ?? [];

  // 1. Write unit file
  const dir = serviceDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const unit = generateUnit(shizuhaParts, extraArgs);
  const unitPath = serviceFilePath();
  const existingUnit = fs.existsSync(unitPath) ? fs.readFileSync(unitPath, 'utf-8') : null;

  if (existingUnit !== unit) {
    fs.writeFileSync(unitPath, unit, { mode: 0o644 });
    console.log(`  Service file: ${unitPath}`);
  }

  // 2. Reload systemd
  execSync('systemctl --user daemon-reload', { stdio: 'ignore' });

  // 3. Enable (auto-start on boot)
  execSync(`systemctl --user enable ${SERVICE_NAME}`, { stdio: 'ignore' });

  // 4. Restart (stop old + start new in one step)
  execSync(`systemctl --user restart ${SERVICE_NAME}`, { stdio: 'ignore' });

  // 5. Enable linger so services run at boot without login
  try {
    const user = process.env['USER'] ?? '';
    if (user) {
      execSync(`loginctl enable-linger ${user}`, { stdio: 'ignore' });
    }
  } catch {
    console.log('  Warning: Could not enable linger (services may not start at boot without login)');
  }
}

/** Stop the service (but keep it enabled for next boot). */
export function stopService(): boolean {
  if (!isServiceInstalled()) return false;
  try {
    execSync(`systemctl --user stop ${SERVICE_NAME}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Fully uninstall: stop, disable, remove unit file. */
export function uninstallService(): boolean {
  if (!isServiceInstalled()) return false;
  try {
    execSync(`systemctl --user stop ${SERVICE_NAME}`, { stdio: 'ignore' });
  } catch { /* may not be running */ }
  try {
    execSync(`systemctl --user disable ${SERVICE_NAME}`, { stdio: 'ignore' });
  } catch { /* may not be enabled */ }
  try {
    fs.rmSync(serviceFilePath(), { force: true });
    execSync('systemctl --user daemon-reload', { stdio: 'ignore' });
  } catch { /* ignore */ }
  return true;
}

/**
 * Resolve the absolute path to the shizuha binary as an array of argv parts.
 * Prefers the currently-running script, falls back to `which shizuha`.
 */
function resolveShizuhaPath(): string[] {
  // If running from dist/shizuha.js, use the node + script combo
  const script = process.argv[1];
  if (script && fs.existsSync(script)) {
    return [process.execPath, path.resolve(script)];
  }
  // Fallback: assume `shizuha` is in PATH
  return ['shizuha'];
}
