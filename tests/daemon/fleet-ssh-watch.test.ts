import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { watchFleetSshCredentialStores, type FleetSshCredentialWatch } from '../../src/daemon/fleet-ssh-watch.js';

const roots: string[] = [];
const watches: FleetSshCredentialWatch[] = [];

afterEach(() => {
  for (const watch of watches.splice(0)) watch.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for fleet-ssh watch event');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('fleet-ssh credential readiness watch', () => {
  it('signals when a new per-agent store gains a private key', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-ssh-watch-'));
    roots.push(root);
    const ready: string[] = [];
    watches.push(watchFleetSshCredentialStores({
      sshRootDir: root,
      debounceMs: 30,
      onCredentialReady: (username) => ready.push(username),
    }));

    const mio = path.join(root, 'mio');
    fs.mkdirSync(mio, { mode: 0o700 });
    fs.writeFileSync(path.join(mio, 'id_ed25519.pub'), 'public');
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(ready).toEqual([]);

    fs.writeFileSync(path.join(mio, 'id_ed25519'), 'private', { mode: 0o600 });
    await waitFor(() => ready.includes('mio'));
  });

  it('watches already-existing empty agent directories', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-ssh-watch-existing-'));
    roots.push(root);
    const san = path.join(root, 'san');
    fs.mkdirSync(san, { mode: 0o700 });
    const ready: string[] = [];
    watches.push(watchFleetSshCredentialStores({
      sshRootDir: root,
      debounceMs: 30,
      onCredentialReady: (username) => ready.push(username),
    }));

    fs.writeFileSync(path.join(san, 'id_rsa'), 'private', { mode: 0o600 });
    await waitFor(() => ready.includes('san'));
  });
});
