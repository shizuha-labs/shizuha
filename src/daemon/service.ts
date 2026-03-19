/**
 * Cross-platform service management for shizuha daemon.
 *
 * Detects the init system and installs accordingly:
 *   - systemd (modern Linux)
 *   - launchd (macOS)
 *   - nohup fallback (Docker, Termux, old Linux, anything else)
 *
 * `shizuha up` installs and starts the service so the daemon:
 *   - Auto-starts on boot (where supported)
 *   - Auto-restarts on crash
 *   - Is managed like any system service
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync, spawn } from 'node:child_process';

const SERVICE_NAME = 'shizuha';

// ── Init system detection ────────────────────────────────────────────

export type InitSystem = 'systemd' | 'launchd' | 'nohup';

let _detected: InitSystem | null = null;

export function detectInitSystem(): InitSystem {
  if (_detected) return _detected;

  // macOS — launchd
  if (process.platform === 'darwin') {
    try {
      execSync('launchctl version', { stdio: 'ignore' });
      _detected = 'launchd';
      return _detected;
    } catch { /* fall through */ }
  }

  // Linux — systemd (user session)
  if (process.platform === 'linux') {
    try {
      execSync('systemctl --user --version', { stdio: 'ignore' });
      _detected = 'systemd';
      return _detected;
    } catch { /* fall through */ }
  }

  // Everything else: Docker, Termux, old sysvinit, WSL1, etc.
  _detected = 'nohup';
  return _detected;
}

/** Human-readable name for the detected init system. */
export function initSystemName(): string {
  switch (detectInitSystem()) {
    case 'systemd': return 'systemd user service';
    case 'launchd': return 'launchd user agent';
    case 'nohup': return 'background process';
  }
}

// ── Shared helpers ───────────────────────────────────────────────────

const home = () => process.env['HOME'] ?? process.env['USERPROFILE'] ?? '~';
const shizuhaDir = () => path.join(home(), '.shizuha');

/** Resolve the shizuha binary as an array of argv parts. */
function resolveShizuhaPath(): string[] {
  const script = process.argv[1];
  if (script && fs.existsSync(script)) {
    return [process.execPath, path.resolve(script)];
  }
  // Check if `shizuha` wrapper exists in ~/.local/bin (installed via install.sh)
  const wrapperPath = path.join(home(), '.local', 'bin', 'shizuha');
  if (fs.existsSync(wrapperPath)) {
    return [wrapperPath];
  }
  return ['shizuha'];
}

function buildExecArgs(extraArgs: string[]): string[] {
  return [...resolveShizuhaPath(), 'up', '--foreground', ...extraArgs];
}

function pidFilePath(): string {
  return path.join(shizuhaDir(), 'daemon.pid');
}

function logFilePath(): string {
  return path.join(shizuhaDir(), 'daemon.log');
}

// ── Public API (delegates to detected init system) ───────────────────

export interface InstallServiceOptions {
  extraArgs?: string[];
}

export function hasServiceManager(): boolean {
  return detectInitSystem() !== 'nohup' || true; // nohup always works
}

export function isServiceInstalled(): boolean {
  switch (detectInitSystem()) {
    case 'systemd': return fs.existsSync(systemdUnitPath());
    case 'launchd': return fs.existsSync(launchdPlistPath());
    case 'nohup': return fs.existsSync(pidFilePath());
  }
}

export function isServiceRunning(): boolean {
  switch (detectInitSystem()) {
    case 'systemd': return systemdIsRunning();
    case 'launchd': return launchdIsRunning();
    case 'nohup': return nohupIsRunning();
  }
}

export function installAndStartService(opts: InstallServiceOptions = {}): void {
  switch (detectInitSystem()) {
    case 'systemd': return systemdInstallAndStart(opts);
    case 'launchd': return launchdInstallAndStart(opts);
    case 'nohup': return nohupInstallAndStart(opts);
  }
}

export function stopService(): boolean {
  switch (detectInitSystem()) {
    case 'systemd': return systemdStop();
    case 'launchd': return launchdStop();
    case 'nohup': return nohupStop();
  }
}

export function uninstallService(): boolean {
  switch (detectInitSystem()) {
    case 'systemd': return systemdUninstall();
    case 'launchd': return launchdUninstall();
    case 'nohup': return nohupStop(); // nothing to uninstall
  }
}

/** Status hints to show the user after install. */
export function statusHints(): { status: string; logs: string; stop: string } {
  switch (detectInitSystem()) {
    case 'systemd':
      return {
        status: 'systemctl --user status shizuha',
        logs: 'journalctl --user -u shizuha -f',
        stop: 'shizuha down',
      };
    case 'launchd':
      return {
        status: 'launchctl list | grep shizuha',
        logs: `tail -f ${logFilePath()}`,
        stop: 'shizuha down',
      };
    case 'nohup':
      return {
        status: `cat ${pidFilePath()}`,
        logs: `tail -f ${logFilePath()}`,
        stop: 'shizuha down',
      };
  }
}

// ── systemd implementation ───────────────────────────────────────────

function systemdServiceDir(): string {
  return path.join(home(), '.config', 'systemd', 'user');
}

function systemdUnitPath(): string {
  return path.join(systemdServiceDir(), `${SERVICE_NAME}.service`);
}

function systemdIsRunning(): boolean {
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

function systemdInstallAndStart(opts: InstallServiceOptions): void {
  const args = buildExecArgs(opts.extraArgs ?? []);
  const execStart = args.map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ');

  const unit = `[Unit]
Description=Shizuha Agent Runtime
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${execStart}
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production
Environment=PATH=${process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin'}
Environment=HOME=${home()}

StandardOutput=journal
StandardError=journal
SyslogIdentifier=shizuha

TimeoutStopSec=15
KillMode=mixed
KillSignal=SIGTERM

[Install]
WantedBy=default.target
`;

  const dir = systemdServiceDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const unitPath = systemdUnitPath();
  const existing = fs.existsSync(unitPath) ? fs.readFileSync(unitPath, 'utf-8') : null;
  if (existing !== unit) {
    fs.writeFileSync(unitPath, unit, { mode: 0o644 });
    console.log(`  Service file: ${unitPath}`);
  }

  execSync('systemctl --user daemon-reload', { stdio: 'ignore' });
  execSync(`systemctl --user enable ${SERVICE_NAME}`, { stdio: 'ignore' });
  execSync(`systemctl --user restart ${SERVICE_NAME}`, { stdio: 'ignore' });

  // Enable linger so services run at boot without login
  try {
    const user = process.env['USER'] ?? '';
    if (user) execSync(`loginctl enable-linger ${user}`, { stdio: 'ignore' });
  } catch {
    console.log('  Warning: Could not enable linger (services may not start at boot without login)');
  }
}

function systemdStop(): boolean {
  if (!fs.existsSync(systemdUnitPath())) return false;
  try {
    execSync(`systemctl --user stop ${SERVICE_NAME}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function systemdUninstall(): boolean {
  if (!fs.existsSync(systemdUnitPath())) return false;
  try { execSync(`systemctl --user stop ${SERVICE_NAME}`, { stdio: 'ignore' }); } catch { /* */ }
  try { execSync(`systemctl --user disable ${SERVICE_NAME}`, { stdio: 'ignore' }); } catch { /* */ }
  try {
    fs.rmSync(systemdUnitPath(), { force: true });
    execSync('systemctl --user daemon-reload', { stdio: 'ignore' });
  } catch { /* */ }
  return true;
}

// ── launchd implementation (macOS) ───────────────────────────────────

function launchdAgentDir(): string {
  return path.join(home(), 'Library', 'LaunchAgents');
}

function launchdPlistPath(): string {
  return path.join(launchdAgentDir(), `com.shizuha.agent.plist`);
}

function launchdIsRunning(): boolean {
  try {
    const result = execSync(`launchctl list ${SERVICE_NAME} 2>/dev/null`, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    // launchctl list <label> outputs PID in first column; "-" means not running
    return !result.startsWith('-');
  } catch {
    return false;
  }
}

function launchdInstallAndStart(opts: InstallServiceOptions): void {
  const args = buildExecArgs(opts.extraArgs ?? []);
  const log = logFilePath();

  // Build plist XML
  const programArgs = args.map((a) => `      <string>${escapeXml(a)}</string>`).join('\n');
  const envVars = Object.entries({
    PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: home(),
    NODE_ENV: 'production',
  }).map(([k, v]) => `        <key>${k}</key>\n        <string>${escapeXml(v)}</string>`).join('\n');

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.shizuha.agent</string>
    <key>ProgramArguments</key>
    <array>
${programArgs}
    </array>
    <key>EnvironmentVariables</key>
    <dict>
${envVars}
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>
    <key>ThrottleInterval</key>
    <integer>5</integer>
    <key>StandardOutPath</key>
    <string>${escapeXml(log)}</string>
    <key>StandardErrorPath</key>
    <string>${escapeXml(log)}</string>
</dict>
</plist>
`;

  const dir = launchdAgentDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  // Ensure log directory exists
  const logDir = path.dirname(log);
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

  const plistPath = launchdPlistPath();
  const existing = fs.existsSync(plistPath) ? fs.readFileSync(plistPath, 'utf-8') : null;

  // Unload old if exists
  if (existing) {
    try { execSync(`launchctl unload "${plistPath}"`, { stdio: 'ignore' }); } catch { /* */ }
  }

  if (existing !== plist) {
    fs.writeFileSync(plistPath, plist, { mode: 0o644 });
    console.log(`  Service file: ${plistPath}`);
  }

  execSync(`launchctl load "${plistPath}"`, { stdio: 'ignore' });
}

function launchdStop(): boolean {
  const plistPath = launchdPlistPath();
  if (!fs.existsSync(plistPath)) return false;
  try {
    execSync(`launchctl unload "${plistPath}"`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function launchdUninstall(): boolean {
  const plistPath = launchdPlistPath();
  if (!fs.existsSync(plistPath)) return false;
  try { execSync(`launchctl unload "${plistPath}"`, { stdio: 'ignore' }); } catch { /* */ }
  try { fs.rmSync(plistPath, { force: true }); } catch { /* */ }
  return true;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── nohup fallback (Docker, Termux, old Linux, etc.) ─────────────────

function nohupIsRunning(): boolean {
  const pidFile = pidFilePath();
  if (!fs.existsSync(pidFile)) return false;
  try {
    const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
    if (isNaN(pid)) return false;
    process.kill(pid, 0); // signal 0 = existence check
    return true;
  } catch {
    return false;
  }
}

function nohupInstallAndStart(opts: InstallServiceOptions): void {
  // Stop existing if running
  nohupStop();

  const args = buildExecArgs(opts.extraArgs ?? []);
  const log = logFilePath();
  const pidFile = pidFilePath();

  // Ensure dirs exist
  const dir = shizuhaDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const [cmd, ...cmdArgs] = args;
  const out = fs.openSync(log, 'a');

  const child = spawn(cmd, cmdArgs, {
    detached: true,
    stdio: ['ignore', out, out],
    env: { ...process.env, NODE_ENV: 'production', SHIZUHA_DAEMON: '1' },
  });

  if (child.pid) {
    fs.writeFileSync(pidFile, String(child.pid), { mode: 0o644 });
  }

  child.unref();
  fs.closeSync(out);
}

function nohupStop(): boolean {
  const pidFile = pidFilePath();
  if (!fs.existsSync(pidFile)) return false;
  try {
    const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
    if (!isNaN(pid)) {
      process.kill(pid, 'SIGTERM');
    }
  } catch { /* not running */ }
  try { fs.rmSync(pidFile, { force: true }); } catch { /* */ }
  return true;
}
