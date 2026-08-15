/**
 * Credential Resolver — file-first, env-fallback credential reader.
 *
 * PLAT-4146: k8s Secrets mounted as volumes hot-update (~1min kubelet sync,
 * atomic symlink swap). By reading credentials from a file path at use-time
 * instead of only from env (frozen at process start), a running agent picks
 * up Secret rotations with zero restart.
 *
 * The file path is typically `/run/shizuha/agent-creds/<KEY>` — the same
 * directory the daemon mounts the per-agent `<username>-agent-creds` Secret
 * into. When the file is absent (legacy env-only images, non-k8s runtimes),
 * falls back to `process.env[KEY]`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const CREDENTIALS_DIR = '/run/shizuha/agent-creds';
const ALLOWED_CREDENTIAL_KEYS = new Set(['AGENT_PASSWORD', 'AGENT_USERNAME']);

/**
 * Read a credential value: file-first at `CREDENTIALS_DIR/<key>`, then
 * `process.env[key]` as fallback.
 *
 * Returns the value, or `undefined` if neither source has it.
 */
export function readAgentCredential(key: string): string | undefined {
  if (!ALLOWED_CREDENTIAL_KEYS.has(key) || key.includes('/') || key.includes('\\') || key.includes('\0') || key.includes('..')) {
    throw new Error(`Unsupported agent credential key: ${JSON.stringify(key)}`);
  }
  // File-first: k8s Secret volume mount hot-updates the file content.
  const filePath = path.resolve(CREDENTIALS_DIR, key);
  const root = `${path.resolve(CREDENTIALS_DIR)}${path.sep}`;
  if (!filePath.startsWith(root)) throw new Error('Agent credential path escapes credential mount');
  try {
    const value = fs.readFileSync(filePath, 'utf-8');
    if (value.length > 0) return value;
  } catch {
    // File absent — expected for legacy env-only images / non-k8s runtimes.
  }

  // Env fallback: frozen at process start but keeps legacy images working.
  return process.env[key] || undefined;
}

/**
 * Read a credential value with a default fallback.
 * Same as `readAgentCredential` but returns `defaultValue` when neither
 * source has the key.
 */
export function readAgentCredentialOrDefault(key: string, defaultValue: string): string {
  return readAgentCredential(key) ?? defaultValue;
}
