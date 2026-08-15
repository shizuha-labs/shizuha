import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const installSh = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'install.sh');

describe('SCLI-586 install.sh --help', () => {
  it('prints usage and writes nothing under HOME', () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'scli586-help-'));
    try {
      const result = spawnSync('bash', [installSh, '--help'], {
        env: { ...process.env, HOME: tmpHome, SHIZUHA_DIR: path.join(tmpHome, '.shizuha') },
        encoding: 'utf-8',
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toMatch(/Usage:/);
      expect(result.stdout).toMatch(/--help/);
      expect(result.stdout).not.toMatch(/静葉/);
      expect(fs.readdirSync(tmpHome)).toEqual([]);
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it('rejects unknown arguments without installing', () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'scli586-bad-'));
    try {
      const result = spawnSync('bash', [installSh, '--please-install'], {
        env: { ...process.env, HOME: tmpHome },
        encoding: 'utf-8',
      });
      expect(result.status).toBe(2);
      expect(fs.readdirSync(tmpHome)).toEqual([]);
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});
