import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the openai module before importing the module under test
const mockCreate = vi.fn();
vi.mock('openai', () => ({
  default: vi.fn().mockImplementation(() => ({
    audio: {
      speech: {
        create: mockCreate,
      },
    },
  })),
}));

// Mock the logger to suppress output in tests
vi.mock('../../src/utils/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const { textToSpeech } = await import('../../src/utils/tts.js');

describe('textToSpeech', () => {
  let originalApiKey: string | undefined;

  beforeEach(() => {
    originalApiKey = process.env['OPENAI_API_KEY'];
    mockCreate.mockReset();
  });

  afterEach(() => {
    if (originalApiKey !== undefined) {
      process.env['OPENAI_API_KEY'] = originalApiKey;
    } else {
      delete process.env['OPENAI_API_KEY'];
    }
  });

  it('returns null when OPENAI_API_KEY is not set', async () => {
    delete process.env['OPENAI_API_KEY'];
    const result = await textToSpeech('Hello world');
    expect(result).toBeNull();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('calls OpenAI TTS API with default voice (alloy) and speed (1.0)', async () => {
    process.env['OPENAI_API_KEY'] = 'test-key';
    const fakeBuffer = new ArrayBuffer(100);
    mockCreate.mockResolvedValue({ arrayBuffer: () => Promise.resolve(fakeBuffer) });

    const result = await textToSpeech('Hello world');
    expect(result).not.toBeNull();
    expect(result!.format).toBe('opus');
    expect(result!.audioBuffer).toBeInstanceOf(Buffer);
    expect(result!.audioBuffer.length).toBe(100);

    expect(mockCreate).toHaveBeenCalledWith({
      model: 'tts-1',
      voice: 'alloy',
      input: 'Hello world',
      response_format: 'opus',
      speed: 1.0,
    });
  });

  it('uses specified voice and speed', async () => {
    process.env['OPENAI_API_KEY'] = 'test-key';
    const fakeBuffer = new ArrayBuffer(50);
    mockCreate.mockResolvedValue({ arrayBuffer: () => Promise.resolve(fakeBuffer) });

    const result = await textToSpeech('Test', { voice: 'echo', speed: 1.5 });
    expect(result).not.toBeNull();
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        voice: 'echo',
        speed: 1.5,
      }),
    );
  });

  it('accepts other valid voices (shimmer, nova, fable, onyx)', async () => {
    process.env['OPENAI_API_KEY'] = 'test-key';
    const fakeBuffer = new ArrayBuffer(10);
    mockCreate.mockResolvedValue({ arrayBuffer: () => Promise.resolve(fakeBuffer) });

    for (const voice of ['shimmer', 'nova', 'fable', 'onyx']) {
      mockCreate.mockClear();
      await textToSpeech('Test', { voice });
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({ voice }),
      );
    }
  });

  it('truncates text at 4096 characters', async () => {
    process.env['OPENAI_API_KEY'] = 'test-key';
    const fakeBuffer = new ArrayBuffer(10);
    mockCreate.mockResolvedValue({ arrayBuffer: () => Promise.resolve(fakeBuffer) });

    const longText = 'A'.repeat(5000);
    await textToSpeech(longText);

    const calledInput = mockCreate.mock.calls[0]![0].input;
    expect(calledInput.length).toBe(4096);
    expect(calledInput).toBe('A'.repeat(4096));
  });

  it('passes text shorter than 4096 unchanged', async () => {
    process.env['OPENAI_API_KEY'] = 'test-key';
    const fakeBuffer = new ArrayBuffer(10);
    mockCreate.mockResolvedValue({ arrayBuffer: () => Promise.resolve(fakeBuffer) });

    const text = 'Short text';
    await textToSpeech(text);
    expect(mockCreate.mock.calls[0]![0].input).toBe(text);
  });

  it('returns null on API error', async () => {
    process.env['OPENAI_API_KEY'] = 'test-key';
    mockCreate.mockRejectedValue(new Error('API rate limit exceeded'));

    const result = await textToSpeech('Hello');
    expect(result).toBeNull();
  });

  it('returns null on network error', async () => {
    process.env['OPENAI_API_KEY'] = 'test-key';
    mockCreate.mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await textToSpeech('Hello');
    expect(result).toBeNull();
  });

  it('returns audio buffer with correct byte length from API response', async () => {
    process.env['OPENAI_API_KEY'] = 'test-key';
    const bytes = new Uint8Array([0x4f, 0x67, 0x67, 0x53]); // OggS header
    mockCreate.mockResolvedValue({
      arrayBuffer: () => Promise.resolve(bytes.buffer),
    });

    const result = await textToSpeech('Test');
    expect(result).not.toBeNull();
    expect(result!.audioBuffer.length).toBe(4);
    expect(result!.audioBuffer[0]).toBe(0x4f);
  });
});
