import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';

it('keeps legacy host publishers inert and independent of any operator home', () => {
  for (const name of ['build-all-platforms.sh', 'build-win.sh']) {
    const file = new URL(`../../rt-build/${name}`, import.meta.url);
    const source = fs.readFileSync(file, 'utf8');
    expect(source).not.toMatch(/\/home\/[^/]+/);
    const result = execFileSync('bash', [file.pathname], {env: {PATH: '/usr/bin:/bin'}, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']});
    expect(result).toBe('');
  }
  const unit = fs.readFileSync(new URL('../../rt-build/systemd/shizuha-rt-build.service', import.meta.url), 'utf8');
  expect(unit).toContain('ConditionPathExists=!/');
  expect(unit).toContain('RefuseManualStart=yes');
  expect(unit).not.toContain('/home/');
  expect(unit).not.toContain('WorkingDirectory=');
});
