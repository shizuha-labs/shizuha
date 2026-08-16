import { describe, expect, it } from 'vitest';

import { gatewayHealthFromRecentErrors } from '../../src/gateway/agent-process.js';
import { TelegramChannel } from '../../src/gateway/channels/telegram.js';
import {
  resolveWhatsAppVerifyToken,
  whatsappWebhookReadyMessage,
} from '../../src/gateway/channels/whatsapp.js';

describe('gatewayHealthFromRecentErrors', () => {
  it('keeps a gateway healthy after a successful turn clears the error ring', () => {
    expect(gatewayHealthFromRecentErrors([])).toEqual({
      ok: true,
      provider_unavailable: false,
      consecutive_error_turns: 0,
    });
  });

  it('marks an alive gateway provider-unavailable after a failed inference turn', () => {
    const error = 'Cannot connect to vLLM at https://cortex.shizuha.com after 10 retries: ECONNREFUSED';
    expect(gatewayHealthFromRecentErrors([error])).toEqual({
      ok: false,
      provider_unavailable: true,
      consecutive_error_turns: 1,
    });
  });

  it('reports the bounded consecutive failure count used by fleet health', () => {
    expect(gatewayHealthFromRecentErrors(['first', 'second']).consecutive_error_turns).toBe(2);
  });

  it('reports a generic turn failure as unhealthy without inventing a provider outage', () => {
    expect(gatewayHealthFromRecentErrors(['Internal tool dispatch invariant failed'])).toEqual({
      ok: false,
      provider_unavailable: false,
      consecutive_error_turns: 1,
    });
  });
});

describe('gateway channel output safety', () => {
  it('does not derive the Telegram channel identity from the bot token', () => {
    const token = 'qa-only-token-marker:noncredential';
    const channel = new TelegramChannel({ type: 'telegram', botToken: token });

    expect(channel.id).toBe('telegram');
    expect(channel.id).not.toContain(token);
    expect(channel.id).not.toContain('qa-only-token-marker');
  });

  it.each([
    ['CLI option', 'qa-cli-verify-token-marker', undefined],
    ['environment', undefined, 'qa-env-verify-token-marker'],
  ])('keeps a WhatsApp verify token from %s out of startup output', (_source, option, env) => {
    const token = resolveWhatsAppVerifyToken(option, env);
    const message = whatsappWebhookReadyMessage(8016);

    expect(token).toBe(option ?? env);
    expect(message).toBe('WhatsApp webhook configured on port 8016');
    expect(message).not.toContain(token!);
  });
});
