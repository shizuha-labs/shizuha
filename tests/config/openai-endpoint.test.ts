import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  applyOpenAIProviderFromDashboard,
  normalizeOpenAICompatibleBaseUrl,
  openaiProviderSettingsView,
  readCredentials,
  setOpenAIEndpoint,
} from '../../src/config/credentials.js';

describe('OpenAI-compatible endpoint store', () => {
  let tmpHome: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    prevHome = process.env['HOME'];
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'scli-oai-ep-'));
    process.env['HOME'] = tmpHome;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = prevHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('appends /v1 when the user omits it', () => {
    expect(normalizeOpenAICompatibleBaseUrl('http://127.0.0.1:8000')).toBe('http://127.0.0.1:8000/v1');
    expect(normalizeOpenAICompatibleBaseUrl('http://127.0.0.1:8000/v1')).toBe('http://127.0.0.1:8000/v1');
    expect(normalizeOpenAICompatibleBaseUrl('http://127.0.0.1:8000/v1/')).toBe('http://127.0.0.1:8000/v1');
  });

  it('persists a URL without requiring an API key or Shizuha login', () => {
    setOpenAIEndpoint({ baseUrl: 'http://127.0.0.1:11434/v1', defaultModel: 'llama3.2' });
    const stored = readCredentials().openai;
    expect(stored?.baseUrl).toBe('http://127.0.0.1:11434/v1');
    expect(stored?.defaultModel).toBe('llama3.2');
    expect(stored?.apiKey).toBeUndefined();
  });

  it('keeps a previous key when only the URL is updated', () => {
    setOpenAIEndpoint({ apiKey: 'sk-test-not-real' });
    setOpenAIEndpoint({ baseUrl: 'http://127.0.0.1:8000/v1' });
    const stored = readCredentials().openai;
    expect(stored?.apiKey).toBe('sk-test-not-real');
    expect(stored?.baseUrl).toBe('http://127.0.0.1:8000/v1');
  });

  it('treats a URL-only store as configured for the dashboard (no Shizuha login)', () => {
    setOpenAIEndpoint({ baseUrl: 'http://127.0.0.1:11434/v1', defaultModel: 'llama3.2' });
    expect(openaiProviderSettingsView(readCredentials().openai)).toEqual({
      configured: true,
      keyPrefix: null,
      baseUrl: 'http://127.0.0.1:11434/v1',
      defaultModel: 'llama3.2',
    });
  });

  it('accepts a dashboard PUT with only a local URL', () => {
    const result = applyOpenAIProviderFromDashboard({
      baseUrl: 'http://127.0.0.1:11434',
      defaultModel: 'llama3.2',
    });
    expect(result).toEqual({ ok: true });
    const stored = readCredentials().openai;
    expect(stored?.baseUrl).toBe('http://127.0.0.1:11434/v1');
    expect(stored?.defaultModel).toBe('llama3.2');
    expect(stored?.apiKey).toBeUndefined();
  });

  it('rejects a dashboard PUT with neither URL nor key', () => {
    expect(applyOpenAIProviderFromDashboard({})).toEqual({
      ok: false,
      error: 'Provide a base URL and/or an API key',
    });
    expect(applyOpenAIProviderFromDashboard({ baseUrl: 'not-a-url' })).toEqual({
      ok: false,
      error: 'Base URL must start with http:// or https://',
    });
  });

  it('lets a later dashboard PUT change only the model on an existing URL', () => {
    applyOpenAIProviderFromDashboard({ baseUrl: 'http://127.0.0.1:8000/v1' });
    const result = applyOpenAIProviderFromDashboard({ defaultModel: 'Qwen3.6-27B' });
    expect(result).toEqual({ ok: true });
    const stored = readCredentials().openai;
    expect(stored?.baseUrl).toBe('http://127.0.0.1:8000/v1');
    expect(stored?.defaultModel).toBe('Qwen3.6-27B');
  });
});
