import { describe, expect, it } from 'vitest';
import {
  pickVoiceS2SAgent,
  voiceS2SUpstreamHttp,
  voiceS2SUpstreamWs,
} from '../../src/daemon/voice-s2s-proxy.js';
import { grokVoiceAuthConfigured } from '../../src/provider/grok-voice.js';
import { voiceS2SSpokenSuffix } from '../../src/voice-s2s/session.js';

describe('Desktop S2S proxy helpers', () => {
  it('picks the agent by username or id', () => {
    const agents = [
      { id: 'a1', username: 'shizuha', localPort: 8017 },
      { id: 'a2', username: 'hina', localPort: 8020 },
    ];
    expect(pickVoiceS2SAgent(agents, 'hina')?.localPort).toBe(8020);
    expect(pickVoiceS2SAgent(agents, 'A1')?.username).toBe('shizuha');
    expect(pickVoiceS2SAgent(agents, '')).toBeNull();
  });

  it('builds loopback upstream URLs', () => {
    expect(voiceS2SUpstreamHttp(8017)).toBe('http://127.0.0.1:8017');
    expect(voiceS2SUpstreamWs(8017, 'tok')).toBe('ws://127.0.0.1:8017/v1/voice/realtime?token=tok');
  });

  it('treats a funded xAI key as enough to overlay Live on a coding model', () => {
    expect(grokVoiceAuthConfigured({ XAI_API_KEY: 'xai-test' })).toBe(true);
    expect(grokVoiceAuthConfigured({ XAI_API_KEY: 'eyJabc' })).toBe(false);
    expect(grokVoiceAuthConfigured({ CORTEX_API_KEY: 'cxk' })).toBe(true);
    expect(grokVoiceAuthConfigured({})).toBe(false);
  });

  it('keeps the SCLI session fingerprint on the Desktop spoken suffix', () => {
    expect(voiceS2SSpokenSuffix('code')).toContain('SCLI realtime path');
    expect(voiceS2SSpokenSuffix('code')).toContain('Shizuha Desktop');
    expect(voiceS2SSpokenSuffix('lean')).toContain('Pulse');
  });
});
