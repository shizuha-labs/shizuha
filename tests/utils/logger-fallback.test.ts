import { describe, expect, it } from 'vitest';
import { createDefaultLogger } from '../../src/utils/logger.js';

describe('logger default sink (SCLI-410 + unwritable HOME)', () => {
  it('does not throw when HOME is an unwritable root path', () => {
    const prevHome = process.env['HOME'];
    const prevFile = process.env['SHIZUHA_LOG_FILE'];
    process.env['HOME'] = '/nonexistent-home-scli446';
    delete process.env['SHIZUHA_LOG_FILE'];
    try {
      expect(() => createDefaultLogger('info', false)).not.toThrow();
      const log = createDefaultLogger('info', false);
      expect(() => log.info('must-not-throw')).not.toThrow();
    } finally {
      if (prevHome === undefined) delete process.env['HOME'];
      else process.env['HOME'] = prevHome;
      if (prevFile === undefined) delete process.env['SHIZUHA_LOG_FILE'];
      else process.env['SHIZUHA_LOG_FILE'] = prevFile;
    }
  });
});
