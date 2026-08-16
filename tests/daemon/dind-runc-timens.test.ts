import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

// HIVE-116: the agent-workspace DinD daemon could not start any container —
// `runc create failed: namespace {"time" ""} does not exist`. Root cause: the
// DIND_DOCKERFILE pinned runc v1.1.x, but runc only gained OCI time-namespace
// support in v1.2.0, while containerd 2.2.x (Docker 29) emits a `time` namespace
// in the OCI spec. Fix: pin a time-namespace-capable runc (>= 1.2.0) and bump the
// DinD image version so the rebuild ships it. This guard keeps the old, broken
// pin from being reintroduced.
describe('HIVE-116 — DinD runc has OCI time-namespace support', () => {
  const managerSource = fs.readFileSync(
    path.resolve(__dirname, '../../src/daemon/manager.ts'),
    'utf-8',
  );

  it('does NOT pin a runc 1.1.x binary (no time-namespace support)', () => {
    expect(managerSource).not.toMatch(/runc\/releases\/download\/v1\.1\.\d+\/runc/);
  });

  it('pins a time-namespace-capable runc (>= 1.2.0) in the DinD image', () => {
    const m = managerSource.match(/runc\/releases\/download\/v(\d+)\.(\d+)\.\d+\/runc/);
    expect(m, 'expected an explicit runc release pin in DIND_DOCKERFILE').not.toBeNull();
    const [major, minor] = [Number(m![1]), Number(m![2])];
    expect(major > 1 || (major === 1 && minor >= 2)).toBe(true);
  });

  it('bumped DIND_IMAGE_VERSION so the fixed runc actually rebuilds', () => {
    const v = managerSource.match(/const DIND_IMAGE_VERSION = '(\d+)'/);
    expect(v, 'expected a DIND_IMAGE_VERSION constant').not.toBeNull();
    expect(Number(v![1])).toBeGreaterThanOrEqual(26);
  });
});
