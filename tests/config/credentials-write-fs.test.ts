// SCLI-438 regression: credential-store WRITE must fail closed on hostile /
// non-regular store or parent shapes (symlink, directory, FIFO, socket,
// unreadable object, hostile parent) with a bounded diagnostic — never a
// destructive replacement, never a hang, never a raw stack.
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execSync } from 'node:child_process';

import {
  writeCredentials,
  validateCredentialStoreWrite,
  credentialsPath,
  credentialsDir,
} from '../../src/config/credentials.js';

const ORIGINAL_HOME = process.env['HOME'];

function withHome<T>(fn: () => T): T {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'scli438-'));
  process.env['HOME'] = home;
  try {
    return fn();
  } finally {
    process.env['HOME'] = ORIGINAL_HOME;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function mkStore(shape: 'dir' | 'fifo' | 'socket' | 'symlink' | 'regular'): void {
  const dir = credentialsDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const p = credentialsPath();
  switch (shape) {
    case 'dir':
      fs.mkdirSync(p);
      break;
    case 'fifo':
      execSync(`mkfifo "${p}"`);
      break;
    case 'socket':
      // A Unix socket is created by net.createServer().listen().
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      require('node:net').createServer().listen(p);
      break;
    case 'symlink':
      fs.symlinkSync('/tmp/scli438-outside-target', p);
      break;
    case 'regular':
      fs.writeFileSync(p, '{}', { mode: 0o600 });
      break;
  }
}

describe('SCLI-438 credential-store write boundary', () => {
  afterEach(() => {
    process.env['HOME'] = ORIGINAL_HOME;
  });

  it('clean missing-store control writes a mode-0600 regular file', () => {
    withHome(() => {
      writeCredentials({ cortex: { apiKey: 'sk-cortex-test' } });
      const p = credentialsPath();
      expect(fs.existsSync(p)).toBe(true);
      expect(fs.statSync(p).isFile()).toBe(true);
      expect(fs.statSync(p).mode & 0o777).toBe(0o600);
      expect(fs.readFileSync(p, 'utf-8')).toContain('sk-cortex-test');
    });
  });

  it('rejects a directory store without mutating it', () => {
    withHome(() => {
      mkStore('dir');
      expect(() => validateCredentialStoreWrite()).toThrow(/not a directory|Refusing/);
      expect(() => writeCredentials({})).toThrow(/Refusing/);
      expect(fs.statSync(credentialsPath()).isDirectory()).toBe(true);
      expect(fs.existsSync(credentialsPath() + '.tmp')).toBe(false);
    });
  });

  it('rejects a FIFO store without hanging or replacing it', () => {
    withHome(() => {
      mkStore('fifo');
      expect(() => validateCredentialStoreWrite()).toThrow(/FIFO/);
      expect(() => writeCredentials({})).toThrow(/FIFO/);
      expect(fs.statSync(credentialsPath()).isFIFO()).toBe(true);
    });
  });

  it('rejects a Unix socket store', () => {
    withHome(() => {
      mkStore('socket');
      expect(() => validateCredentialStoreWrite()).toThrow(/socket/);
      expect(() => writeCredentials({})).toThrow(/socket/);
    });
  });

  it('rejects a symlink store without touching the outside target', () => {
    withHome(() => {
      const target = '/tmp/scli438-outside-target';
      fs.writeFileSync(target, 'sentinel');
      mkStore('symlink');
      expect(() => validateCredentialStoreWrite()).toThrow(/symbolic link/);
      expect(() => writeCredentials({})).toThrow(/symbolic link/);
      expect(fs.readFileSync(target, 'utf-8')).toBe('sentinel');
    });
  });

  it('rejects a hostile parent (regular file at ~/.shizuha)', () => {
    withHome(() => {
      const dir = credentialsDir();
      fs.writeFileSync(dir, 'not a dir');
      expect(() => validateCredentialStoreWrite()).toThrow(/not a directory/);
      expect(() => writeCredentials({})).toThrow(/not a directory/);
      expect(fs.readFileSync(dir, 'utf-8')).toBe('not a dir');
    });
  });

  it('accepts an existing regular store (in-place update)', () => {
    withHome(() => {
      mkStore('regular');
      writeCredentials({ cortex: { apiKey: 'sk-cortex-updated' } });
      expect(fs.readFileSync(credentialsPath(), 'utf-8')).toContain('sk-cortex-updated');
    });
  });
});
