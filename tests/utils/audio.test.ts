import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { downloadAudio, transcribeAudio } from '../../src/utils/audio.js';

// ── downloadAudio ──

describe('downloadAudio', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('downloads audio and returns a Buffer', async () => {
    const fakeAudioData = new Uint8Array([0x4f, 0x67, 0x67, 0x53]); // OGG magic bytes
    const mockResponse = {
      ok: true,
      arrayBuffer: vi.fn().mockResolvedValue(fakeAudioData.buffer),
    };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse as any);

    const result = await downloadAudio('https://example.com/audio.ogg');
    expect(result).toBeInstanceOf(Buffer);
    expect(result!.length).toBe(4);
    expect(fetch).toHaveBeenCalledWith('https://example.com/audio.ogg', expect.objectContaining({
      signal: expect.any(AbortSignal),
    }));
  });

  it('passes custom headers to fetch', async () => {
    const fakeAudioData = new Uint8Array([1, 2, 3]);
    const mockResponse = {
      ok: true,
      arrayBuffer: vi.fn().mockResolvedValue(fakeAudioData.buffer),
    };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse as any);

    await downloadAudio('https://example.com/audio.ogg', { Authorization: 'Bearer token123' });

    expect(fetch).toHaveBeenCalledWith('https://example.com/audio.ogg', expect.objectContaining({
      headers: { Authorization: 'Bearer token123' },
    }));
  });

  it('returns null on HTTP error status', async () => {
    const mockResponse = { ok: false, status: 404 };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse as any);

    const result = await downloadAudio('https://example.com/missing.ogg');
    expect(result).toBeNull();
  });

  it('returns null when audio exceeds 25MB limit', async () => {
    // Create a response that appears to return >25MB
    const bigBuffer = new ArrayBuffer(26 * 1024 * 1024); // 26MB
    const mockResponse = {
      ok: true,
      arrayBuffer: vi.fn().mockResolvedValue(bigBuffer),
    };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse as any);

    const result = await downloadAudio('https://example.com/huge.ogg');
    expect(result).toBeNull();
  });

  it('returns buffer when audio is exactly 25MB', async () => {
    const exactBuffer = new ArrayBuffer(25 * 1024 * 1024); // exactly 25MB
    const mockResponse = {
      ok: true,
      arrayBuffer: vi.fn().mockResolvedValue(exactBuffer),
    };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse as any);

    const result = await downloadAudio('https://example.com/exact.ogg');
    expect(result).toBeInstanceOf(Buffer);
    expect(result!.length).toBe(25 * 1024 * 1024);
  });

  it('returns null on network error', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await downloadAudio('https://example.com/audio.ogg');
    expect(result).toBeNull();
  });

  it('returns null on timeout', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new DOMException('signal timed out', 'AbortError'));

    const result = await downloadAudio('https://example.com/slow.ogg');
    expect(result).toBeNull();
  });

  it('uses a 60-second timeout signal', async () => {
    const fakeData = new Uint8Array([1]);
    const mockResponse = {
      ok: true,
      arrayBuffer: vi.fn().mockResolvedValue(fakeData.buffer),
    };
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse as any);

    await downloadAudio('https://example.com/audio.ogg');

    const callArgs = fetchSpy.mock.calls[0]!;
    const options = callArgs[1] as RequestInit;
    expect(options.signal).toBeDefined();
    // The AbortSignal.timeout(60_000) creates a signal — we just verify it exists
  });
});

// ── transcribeAudio ──

describe('transcribeAudio', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    // Reset modules for each test to re-evaluate the dynamic import
    vi.resetModules();
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it('returns null when OPENAI_API_KEY is not set', async () => {
    const savedKey = process.env['OPENAI_API_KEY'];
    delete process.env['OPENAI_API_KEY'];

    const result = await transcribeAudio(Buffer.from('audio data'));
    expect(result).toBeNull();

    // Restore
    if (savedKey) process.env['OPENAI_API_KEY'] = savedKey;
  });

  it('calls whisper-1 API and returns transcription text', async () => {
    process.env['OPENAI_API_KEY'] = 'test-key-123';

    const mockTranscription = { text: '  Hello, world!  ' };
    const mockCreate = vi.fn().mockResolvedValue(mockTranscription);

    // Mock the dynamic import of openai
    vi.doMock('openai', () => ({
      default: class MockOpenAI {
        audio = {
          transcriptions: {
            create: mockCreate,
          },
        };
      },
    }));

    // Re-import to get fresh module with mock
    const { transcribeAudio: freshTranscribe } = await import('../../src/utils/audio.js');

    const audioBuffer = Buffer.from('fake audio data');
    const result = await freshTranscribe(audioBuffer);

    expect(result).not.toBeNull();
    expect(result!.text).toBe('Hello, world!'); // trimmed

    // Verify the API was called with correct params
    expect(mockCreate).toHaveBeenCalledTimes(1);
    const callArgs = mockCreate.mock.calls[0]![0];
    expect(callArgs.model).toBe('whisper-1');
    expect(callArgs.file).toBeInstanceOf(File);
  });

  it('uses custom fileName when provided', async () => {
    process.env['OPENAI_API_KEY'] = 'test-key-123';

    const mockCreate = vi.fn().mockResolvedValue({ text: 'Transcribed' });

    vi.doMock('openai', () => ({
      default: class MockOpenAI {
        audio = {
          transcriptions: {
            create: mockCreate,
          },
        };
      },
    }));

    const { transcribeAudio: freshTranscribe } = await import('../../src/utils/audio.js');

    await freshTranscribe(Buffer.from('data'), { fileName: 'voice.mp3' });

    const callArgs = mockCreate.mock.calls[0]![0];
    expect(callArgs.file.name).toBe('voice.mp3');
  });

  it('passes language option to API', async () => {
    process.env['OPENAI_API_KEY'] = 'test-key-123';

    const mockCreate = vi.fn().mockResolvedValue({ text: 'Hola mundo' });

    vi.doMock('openai', () => ({
      default: class MockOpenAI {
        audio = {
          transcriptions: {
            create: mockCreate,
          },
        };
      },
    }));

    const { transcribeAudio: freshTranscribe } = await import('../../src/utils/audio.js');

    await freshTranscribe(Buffer.from('data'), { language: 'es' });

    const callArgs = mockCreate.mock.calls[0]![0];
    expect(callArgs.language).toBe('es');
  });

  it('returns null when transcription text is empty', async () => {
    process.env['OPENAI_API_KEY'] = 'test-key-123';

    const mockCreate = vi.fn().mockResolvedValue({ text: '' });

    vi.doMock('openai', () => ({
      default: class MockOpenAI {
        audio = {
          transcriptions: {
            create: mockCreate,
          },
        };
      },
    }));

    const { transcribeAudio: freshTranscribe } = await import('../../src/utils/audio.js');

    const result = await freshTranscribe(Buffer.from('silence'));
    expect(result).toBeNull();
  });

  it('returns null when API throws an error', async () => {
    process.env['OPENAI_API_KEY'] = 'test-key-123';

    const mockCreate = vi.fn().mockRejectedValue(new Error('Rate limited'));

    vi.doMock('openai', () => ({
      default: class MockOpenAI {
        audio = {
          transcriptions: {
            create: mockCreate,
          },
        };
      },
    }));

    const { transcribeAudio: freshTranscribe } = await import('../../src/utils/audio.js');

    const result = await freshTranscribe(Buffer.from('data'));
    expect(result).toBeNull();
  });

  it('defaults fileName to audio.ogg when not specified', async () => {
    process.env['OPENAI_API_KEY'] = 'test-key-123';

    const mockCreate = vi.fn().mockResolvedValue({ text: 'Default name' });

    vi.doMock('openai', () => ({
      default: class MockOpenAI {
        audio = {
          transcriptions: {
            create: mockCreate,
          },
        };
      },
    }));

    const { transcribeAudio: freshTranscribe } = await import('../../src/utils/audio.js');

    await freshTranscribe(Buffer.from('data'));

    const callArgs = mockCreate.mock.calls[0]![0];
    expect(callArgs.file.name).toBe('audio.ogg');
  });

  it('does not pass language to API when not specified', async () => {
    process.env['OPENAI_API_KEY'] = 'test-key-123';

    const mockCreate = vi.fn().mockResolvedValue({ text: 'No language' });

    vi.doMock('openai', () => ({
      default: class MockOpenAI {
        audio = {
          transcriptions: {
            create: mockCreate,
          },
        };
      },
    }));

    const { transcribeAudio: freshTranscribe } = await import('../../src/utils/audio.js');

    await freshTranscribe(Buffer.from('data'));

    const callArgs = mockCreate.mock.calls[0]![0];
    expect(callArgs.language).toBeUndefined();
  });
});
