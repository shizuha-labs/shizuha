import { randomBytes } from 'node:crypto';
import { chmod, mkdir, open, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export type AsyncCleanup = () => Promise<void>;

export interface CoreConnectionBinding {
  generation: number;
  sessionId: string;
  rootUri: string;
}

export function isCurrentCoreBinding(binding: CoreConnectionBinding, current: CoreConnectionBinding): boolean {
  return binding.generation === current.generation
    && binding.sessionId === current.sessionId
    && binding.rootUri === current.rootUri;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export function trustedLocalCoreEndpoint(endpoint: string, workspaceTrusted: boolean): string {
  if (!workspaceTrusted) throw new Error('Trust this workspace before Shizuha can connect to the local core.');
  const parsed = new URL(endpoint);
  if (parsed.protocol !== 'http:') throw new Error('Shizuha local core must use loopback HTTP.');
  if (parsed.username || parsed.password || !LOOPBACK_HOSTS.has(parsed.hostname)) {
    throw new Error('Shizuha local core must use a loopback-only endpoint.');
  }
  return parsed.toString().replace(/\/$/, '');
}

export function deactivateWithCleanup(cleanup: AsyncCleanup): Promise<void> {
  return cleanup();
}

/**
 * Per-install core identity capability. It is deliberately outside
 * SecretStorage so a rogue loopback listener is rejected before any provider
 * SecretStorage access. The containing VS Code global-storage directory and
 * the file are owner-only.
 */
export async function loadOrCreateCoreCapability(globalStoragePath: string): Promise<string> {
  await mkdir(globalStoragePath, { recursive: true, mode: 0o700 });
  const target = join(globalStoragePath, 'local-core.capability');
  try {
    const handle = await open(target, 'wx', 0o600);
    try {
      const capability = randomBytes(32).toString('base64url');
      await handle.writeFile(`${capability}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
  await chmod(globalStoragePath, 0o700);
  await chmod(target, 0o600);
  const capability = (await readFile(target, 'utf8')).trim();
  if (!/^[A-Za-z0-9_-]{43}$/.test(capability)) throw new Error('Local core capability file is invalid');
  return capability;
}
