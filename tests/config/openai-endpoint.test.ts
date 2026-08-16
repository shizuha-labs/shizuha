import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  normalizeOpenAICompatibleBaseUrl,
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
});
