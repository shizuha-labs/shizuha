import { describe, expect, it } from 'vitest';
import { isLoopbackAddress, verifyVoiceS2SToken } from '../../src/voice-s2s/auth.js';

describe('voice S2S auth', () => {
  it('accepts loopback addresses used by local gateway tests', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('10.42.0.8')).toBe(false);
  });

  it('accepts a matching internal token without calling ID', async () => {
    const prev = process.env['SHIZUHA_VOICE_INTERNAL_TOKEN'];
    process.env['SHIZUHA_VOICE_INTERNAL_TOKEN'] = 'shared-voice';
    try {
      const fetchImpl = async () => { throw new Error('should not fetch'); };
      expect(await verifyVoiceS2SToken('shared-voice', { fetchImpl: fetchImpl as unknown as typeof fetch })).toBe(true);
      expect(await verifyVoiceS2SToken('nope', {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        platformUrl: '',
      })).toBe(false);
    } finally {
      if (prev === undefined) delete process.env['SHIZUHA_VOICE_INTERNAL_TOKEN'];
      else process.env['SHIZUHA_VOICE_INTERNAL_TOKEN'] = prev;
    }
  });

  it('accepts a platform JWT that ID verifies', async () => {
    const prev = process.env['SHIZUHA_VOICE_INTERNAL_TOKEN'];
    delete process.env['SHIZUHA_VOICE_INTERNAL_TOKEN'];
    try {
      const fetchImpl = async (url: RequestInfo | URL) => {
        expect(String(url)).toBe('https://id.example/id/api/auth/user/');
        return { ok: true } as Response;
      };
      expect(await verifyVoiceS2SToken('jwt-1', {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        platformUrl: 'https://id.example',
      })).toBe(true);
    } finally {
      if (prev !== undefined) process.env['SHIZUHA_VOICE_INTERNAL_TOKEN'] = prev;
    }
  });
});
