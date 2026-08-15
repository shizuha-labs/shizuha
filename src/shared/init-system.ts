/**
 * Init-system detection used by `shizuha update` and the fleet daemon installer.
 * Kept out of src/daemon so the harness can import it without the supervisor.
 */
import { execSync } from 'node:child_process';

export type InitSystem = 'systemd' | 'launchd' | 'nohup';

let _detected: InitSystem | null = null;

export function detectInitSystem(): InitSystem {
  if (_detected) return _detected;

  if (process.platform === 'darwin') {
    try {
      execSync('launchctl version', { stdio: 'ignore' });
      _detected = 'launchd';
      return _detected;
    } catch { /* fall through */ }
  }

  if (process.platform === 'linux') {
    try {
      execSync('systemctl --user --version', { stdio: 'ignore' });
      _detected = 'systemd';
      return _detected;
    } catch { /* fall through */ }
  }

  _detected = 'nohup';
  return _detected;
}
