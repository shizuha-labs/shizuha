import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  isGptCodexModel,
  buildGptCodexProviderArgs,
  ensureGptStaticCatalog,
} from '../../src/codex-bridge/index.js';

// PLAT-4205 — gpt-* codex agents must use the HTTP-only chatgpt-http provider +
// a pinned static catalog (openai/codex#22634 WS-wedge). Ported from deprecated#3
// + sara2574/deprecated#1 to the canonical shizuha-beta codex-bridge, with the
// corrected endpoint and revi's failure-atomic / never-undefined-provider P1s.

describe('PLAT-4205 isGptCodexModel', () => {
  it('matches gpt-* case-insensitively, rejects Cortex/local models', () => {
    expect(isGptCodexModel('gpt-5.6-sol')).toBe(true);
    expect(isGptCodexModel('GPT-5')).toBe(true);
    expect(isGptCodexModel('deepseek-v3')).toBe(false);
    expect(isGptCodexModel('qwen3-coder')).toBe(false);
    expect(isGptCodexModel(undefined)).toBe(false);
    expect(isGptCodexModel('')).toBe(false);
  });
});

describe('PLAT-4205 buildGptCodexProviderArgs', () => {
  it('gpt model: fully defines chatgpt-http at the CORRECTED endpoint', () => {
    const joined = buildGptCodexProviderArgs(
      'gpt-5.6-sol',
      '/home/agent/.codex-home/sara/model-catalog.json',
    ).join(' ');
    // revi P1: the provider is selected AND fully defined inline — never undefined.
    expect(joined).toContain('model_provider=chatgpt-http');
    expect(joined).toContain('model_providers.chatgpt-http.name=chatgpt-http');
    expect(joined).toContain('model_providers.chatgpt-http.wire_api=responses');
    expect(joined).toContain('model_providers.chatgpt-http.requires_openai_auth=true');
    expect(joined).toContain('model_providers.chatgpt-http.supports_websockets=false');
    // Corrected endpoint (revi-verified), NOT the stale deprecated#3 api.openai.com.
    expect(joined).toContain('model_providers.chatgpt-http.base_url=https://chatgpt.com/backend-api/codex');
  });

  it('gpt model: prefers agent-gateway base_url when present', () => {
    const args = buildGptCodexProviderArgs('gpt-5.6-sol', '/tmp/model-catalog.json', {
      OPENAI_BASE_URL: 'http://agent-gateway:9300/codex',
    } as NodeJS.ProcessEnv);
    const joined = args.join(' ');
    expect(joined).toContain('model_providers.chatgpt-http.base_url=http://agent-gateway:9300/codex');
    expect(joined).not.toContain('base_url=https://chatgpt.com/backend-api/codex');
    expect(joined).not.toContain('api.openai.com');
    // catalog pinned when a path is provided.
    expect(joined).toContain('model_catalog_json=');
  });

  it('gpt model with null catalog: provider still defined, no model_catalog_json', () => {
    const joined = buildGptCodexProviderArgs('gpt-5', null).join(' ');
    expect(joined).toContain('model_provider=chatgpt-http');
    expect(joined).toContain('base_url=https://chatgpt.com/backend-api/codex');
    expect(joined).not.toContain('model_catalog_json');
  });

  it('non-gpt / undefined model: no provider args (keeps default/Cortex routing)', () => {
    expect(buildGptCodexProviderArgs('deepseek-v3', '/x')).toEqual([]);
    expect(buildGptCodexProviderArgs(undefined, null)).toEqual([]);
  });

  it('emits well-formed -c pairs', () => {
    const args = buildGptCodexProviderArgs('gpt-5', null);
    expect(args.length % 2).toBe(0);
    for (let i = 0; i < args.length; i += 2) expect(args[i]).toBe('-c');
  });
});

describe('PLAT-4205 ensureGptStaticCatalog (production paths)', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plat4205-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const fakeCodex = (body: string): string => {
    const p = path.join(tmp, 'fake-codex');
    fs.writeFileSync(p, `#!/bin/sh\ncat <<'JSON'\n${body}\nJSON\n`, { mode: 0o755 });
    return p;
  };

  it('non-gpt model: returns null and writes nothing', () => {
    const codexHome = path.join(tmp, 'home');
    expect(ensureGptStaticCatalog('deepseek-v3', codexHome, '/bin/true')).toBeNull();
    expect(fs.existsSync(path.join(codexHome, 'model-catalog.json'))).toBe(false);
  });

  it('gpt model: writes a gpt-filtered catalog atomically + returns its path', () => {
    const codexHome = path.join(tmp, 'home');
    const codex = fakeCodex(
      JSON.stringify({
        models: [
          { slug: 'gpt-5.6-sol', display_name: 'GPT-5.6' },
          { slug: 'deepseek-v3', display_name: 'DeepSeek' },
        ],
      }),
    );
    const out = ensureGptStaticCatalog('gpt-5.6-sol', codexHome, codex);
    expect(out).toBe(path.join(codexHome, 'model-catalog.json'));
    const written = JSON.parse(fs.readFileSync(out as string, 'utf-8')) as {
      models: Array<{ slug: string }>;
    };
    expect(written.models.map((m) => m.slug)).toEqual(['gpt-5.6-sol']); // gpt-filtered
    expect(fs.existsSync(`${out}.tmp`)).toBe(false); // atomic tmp+rename left no tmp
  });

  it('generation failure (bad codex path): returns null, degrades, never throws', () => {
    const codexHome = path.join(tmp, 'home');
    expect(() =>
      ensureGptStaticCatalog('gpt-5', codexHome, '/nonexistent/codex-xyz'),
    ).not.toThrow();
    expect(ensureGptStaticCatalog('gpt-5', codexHome, '/nonexistent/codex-xyz')).toBeNull();
  });

  it('no gpt-* models in bundled output: returns null (never pins a bad catalog)', () => {
    const codexHome = path.join(tmp, 'home');
    const codex = fakeCodex(JSON.stringify({ models: [{ slug: 'deepseek-v3' }] }));
    expect(ensureGptStaticCatalog('gpt-5', codexHome, codex)).toBeNull();
    expect(fs.existsSync(path.join(codexHome, 'model-catalog.json'))).toBe(false);
  });
});
