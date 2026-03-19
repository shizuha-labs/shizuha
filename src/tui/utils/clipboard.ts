import { execSync, spawnSync } from 'node:child_process';

/** Write text to system clipboard. Returns true on success. */
export function writeClipboardText(text: string): boolean {
  const methods = [
    ['xclip', ['-selection', 'clipboard']],
    ['xsel', ['--clipboard', '--input']],
    ['wl-copy', []],
  ] as const;

  for (const [cmd, args] of methods) {
    try {
      const result = spawnSync(cmd, [...args], {
        input: text,
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      if (result.status === 0) return true;
    } catch { /* try next */ }
  }
  return false;
}

/** Read clipboard image as base64 PNG. Returns null if no image available. */
export function readClipboardImage(): string | null {
  try {
    // Try xclip first (Linux)
    const data = execSync('xclip -selection clipboard -t image/png -o | base64', {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return data.length > 100 ? data : null;
  } catch {
    try {
      // Try xsel as fallback
      const data = execSync('xsel --clipboard --output | base64', {
        encoding: 'utf-8',
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      return data.length > 100 ? data : null;
    } catch {
      return null;
    }
  }
}
