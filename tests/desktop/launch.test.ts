import { describe, expect, it } from 'vitest';
import { historyItems, realtimeVoiceUrl } from '../../src/web/lib/grokVoiceClient.js';

describe('Desktop Live client helpers', () => {
  it('keeps a short spoken history for session.start', () => {
    const items = historyItems([
      { id: '1', role: 'user', content: '  open App.tsx  ', createdAt: '' },
      { id: '2', role: 'assistant', content: 'Opened.', createdAt: '' },
      { id: '3', role: 'system', content: 'ignore', createdAt: '' },
    ], 12);
    expect(items).toEqual([
      { role: 'user', text: 'open App.tsx' },
      { role: 'assistant', text: 'Opened.' },
    ]);
  });

  it('points Live at the dashboard proxy, not xAI', () => {
    const url = realtimeVoiceUrl('shizuha');
    expect(url).toContain('/v1/voice/realtime?agent=shizuha');
    expect(url).not.toContain('api.x.ai');
  });
});
