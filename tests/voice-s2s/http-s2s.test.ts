import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HttpChannel } from '../../src/gateway/channels/http.js';
import type { Inbox, InboundMessage } from '../../src/gateway/types.js';

const PORT = 19821 + Math.floor(Math.random() * 400);
const BASE = `http://127.0.0.1:${PORT}`;

class QuietInbox implements Inbox {
  readonly depth = 0;
  readonly busy = false;
  push(_msg: InboundMessage): void {}
  async next(): Promise<InboundMessage> {
    throw new Error('unused');
  }
}

describe('HttpChannel /v1/voice/s2s', () => {
  let channel: HttpChannel;

  beforeAll(async () => {
    channel = new HttpChannel({
      port: PORT,
      host: '127.0.0.1',
      getVoiceS2SHost: () => ({
        model: 'cortex/grok-voice-think-fast-2.0',
        instructions: 'You are Hina.',
        tools: [
          { name: 'mcp__shizuha-pulse__pulse_get_my_tasks', description: 'queue', inputSchema: { type: 'object', properties: {} } },
        ],
        executeTool: async () => 'ok',
      }),
    });
    await channel.start(new QuietInbox());
  });

  afterAll(async () => {
    await channel.stop();
  });

  it('advertises the SCLI realtime path and live tools', async () => {
    const resp = await fetch(`${BASE}/v1/voice/s2s`);
    expect(resp.status).toBe(200);
    const body = await resp.json() as { ok: boolean; path: string; tools: string[] };
    expect(body.ok).toBe(true);
    expect(body.path).toBe('/v1/voice/realtime');
    expect(body.tools).toContain('pulse_get_my_tasks');
  });
});
