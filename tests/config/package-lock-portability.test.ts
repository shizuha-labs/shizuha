import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('package-lock portability', () => {
  it('does not pin tarballs to cluster-only registry hostnames', () => {
    const lockPath = fileURLToPath(
      new URL('../../package-lock.json', import.meta.url),
    );
    const lock = readFileSync(lockPath, 'utf8');

    expect(lock).not.toContain('.svc.cluster.local');
    expect(lock).not.toContain('npm-cache.registry');
  });
});
