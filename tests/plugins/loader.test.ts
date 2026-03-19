import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PluginLoader } from '../../src/plugins/loader.js';
import { ToolRegistry } from '../../src/tools/registry.js';

const tempDirs: string[] = [];

function makeTempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shizuha-plugin-loader-'));
  tempDirs.push(dir);
  return dir;
}

function writePlugin(homeDir: string, pluginId: string, indexJs: string): void {
  const pluginDir = path.join(homeDir, '.shizuha', 'plugins', pluginId);
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(path.join(pluginDir, 'plugin.json'), JSON.stringify({ id: pluginId }, null, 2));
  fs.writeFileSync(path.join(pluginDir, 'index.js'), indexJs);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('PluginLoader', () => {
  it('tracks provider registrations without crashing load summary', async () => {
    const homeDir = makeTempHome();
    const previousHome = process.env['HOME'];
    process.env['HOME'] = homeDir;

    try {
      writePlugin(homeDir, 'provider-test', `
        module.exports = {
          id: 'provider-test',
          async register(api) {
            api.registerProvider('provider-test', { name: 'provider-test', complete() { throw new Error('unused'); }, stream() { throw new Error('unused'); } });
          },
        };
      `);

      const loader = new PluginLoader({
        workspaceDir: homeDir,
        toolRegistry: new ToolRegistry(),
        allowList: ['provider-test'],
      });

      const entries = await loader.loadAll();
      expect(entries).toHaveLength(1);
      expect(entries[0]?.status).toBe('loaded');
      expect(entries[0]?.providers).toEqual(['provider-test']);
      expect(loader.getProviders().has('provider-test')).toBe(true);
    } finally {
      if (previousHome === undefined) delete process.env['HOME'];
      else process.env['HOME'] = previousHome;
    }
  });
});
