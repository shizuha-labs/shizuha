/**
 * Dashboard → agent-gateway speech-to-speech proxy.
 *
 * Desktop / dashboard stay on :8015/:8016. Live PCM is forwarded to the
 * selected agent's SCLI `/v1/voice/realtime` so tools stay in that process.
 */
// @ts-ignore — ws has no declaration file in this project
import WebSocket, { WebSocketServer } from 'ws';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { isLoopbackAddress } from '../voice-s2s/auth.js';

export interface VoiceS2SAgentTarget {
  id: string;
  username: string;
  localPort?: number | null;
  model?: string;
}

export function pickVoiceS2SAgent(
  agents: VoiceS2SAgentTarget[],
  query: string,
): VoiceS2SAgentTarget | null {
  const want = String(query || '').trim().toLowerCase();
  if (!want) return null;
  return agents.find((row) => {
    const names = [row.username, row.id];
    return names.some((name) => String(name || '').trim().toLowerCase() === want);
  }) ?? null;
}

export function voiceS2SUpstreamHttp(port: number): string {
  return `http://127.0.0.1:${port}`;
}

export function voiceS2SUpstreamWs(port: number, token = ''): string {
  const qs = token ? `?token=${encodeURIComponent(token)}` : '';
  return `ws://127.0.0.1:${port}/v1/voice/realtime${qs}`;
}

export async function probeVoiceS2S(
  port: number,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; model?: string | null; tools?: string[] }> {
  try {
    const resp = await fetchImpl(`${voiceS2SUpstreamHttp(port)}/v1/voice/s2s`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!resp.ok) return { ok: false };
    const body = await resp.json() as { ok?: boolean; model?: string | null; tools?: string[] };
    return {
      ok: Boolean(body?.ok),
      model: body?.model ?? null,
      tools: Array.isArray(body?.tools) ? body.tools : [],
    };
  } catch {
    return { ok: false };
  }
}

const voiceWss = new WebSocketServer({ noServer: true });

/** Returns true when this request is the Live S2S socket (handled or rejected). */
export function tryHandleVoiceS2SUpgrade(
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  opts: {
    resolveAgent: (query: string) => VoiceS2SAgentTarget | null;
    isAllowed: (req: IncomingMessage, remoteIp: string) => boolean;
  },
): boolean {
  const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
  if (url.pathname !== '/v1/voice/realtime' && url.pathname !== '/v1/voice/realtime/') {
    return false;
  }
  const remoteIp = request.socket.remoteAddress || '';
  if (!opts.isAllowed(request, remoteIp) && !isLoopbackAddress(remoteIp)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return true;
  }
  const agent = opts.resolveAgent(url.searchParams.get('agent') || '');
  const port = Number(agent?.localPort);
  if (!agent || !Number.isFinite(port) || port <= 0) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return true;
  }
  const token = url.searchParams.get('token') || '';
  voiceWss.handleUpgrade(request, socket, head, (client: WebSocket) => {
    const upstream = new WebSocket(voiceS2SUpstreamWs(port, token));
    const closeBoth = () => {
      try { client.close(); } catch { /* ignore */ }
      try { upstream.close(); } catch { /* ignore */ }
    };
    upstream.on('open', () => {
      client.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
        if (upstream.readyState === WebSocket.OPEN) {
          upstream.send(data, { binary: isBinary });
        }
      });
      upstream.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(data, { binary: isBinary });
        }
      });
    });
    upstream.on('error', closeBoth);
    upstream.on('close', closeBoth);
    client.on('error', closeBoth);
    client.on('close', closeBoth);
  });
  return true;
}
