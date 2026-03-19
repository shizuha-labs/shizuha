/**
 * Lightweight HTTPS CONNECT proxy for agent containers.
 *
 * Rust HTTP clients (e.g. Codex CLI's reqwest) don't fall back from IPv6 to
 * IPv4 when DNS returns AAAA records first. Docker containers often lack IPv6
 * connectivity, so these clients fail to connect to hosts like chatgpt.com.
 *
 * This proxy runs on the host (Node.js, which handles IPv4/IPv6 correctly)
 * and agent containers set HTTPS_PROXY=http://host.docker.internal:<port>.
 * The proxy handles DNS resolution on the host side, then tunnels the TCP
 * connection transparently (CONNECT method). TLS is end-to-end between the
 * client and upstream — no MITM, no cert issues.
 *
 * Inspired by the agent-gateway pattern in shizuha-agent.
 */

import * as http from 'node:http';
import * as net from 'node:net';

let proxyServer: http.Server | null = null;
let proxyPort = 0;

/**
 * Start the HTTPS CONNECT proxy. Returns the port it's listening on.
 * Idempotent — returns existing port if already running.
 */
export async function startHttpsProxy(): Promise<number> {
  if (proxyServer && proxyPort > 0) return proxyPort;

  const server = http.createServer((_req, res) => {
    // Only CONNECT method is supported (HTTPS tunneling)
    res.writeHead(405, { 'Content-Type': 'text/plain' });
    res.end('Method Not Allowed — this proxy only supports CONNECT');
  });

  // Handle CONNECT method — transparent TCP tunnel
  server.on('connect', (req: http.IncomingMessage, clientSocket: net.Socket, head: Buffer) => {
    const target = req.url ?? '';
    const [hostname, portStr] = target.split(':');
    const port = parseInt(portStr ?? '443', 10);

    console.log(`[https-proxy] CONNECT ${target} (head=${head.length}b)`);

    if (!hostname) {
      console.error(`[https-proxy] Bad CONNECT target: ${target}`);
      clientSocket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      clientSocket.destroy();
      return;
    }

    const serverSocket = net.connect({ port, host: hostname, family: 4 }, () => {
      console.log(`[https-proxy] Tunnel established: ${target} → ${serverSocket.remoteAddress}:${serverSocket.remotePort}`);
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) serverSocket.write(head);
      serverSocket.pipe(clientSocket);
      clientSocket.pipe(serverSocket);
    });

    serverSocket.on('error', (err) => {
      console.error(`[https-proxy] Connection to ${target} failed: ${err.message}`);
      if (!clientSocket.destroyed) {
        clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
        clientSocket.destroy();
      }
    });

    clientSocket.on('error', (err) => {
      console.error(`[https-proxy] Client socket error for ${target}: ${err.message}`);
      if (!serverSocket.destroyed) serverSocket.destroy();
    });

    serverSocket.on('close', () => {
      if (!clientSocket.destroyed) clientSocket.destroy();
    });

    clientSocket.on('close', () => {
      if (!serverSocket.destroyed) serverSocket.destroy();
    });

    // Timeout idle tunnels after 5 minutes
    serverSocket.setTimeout(300_000, () => serverSocket.destroy());
    clientSocket.setTimeout(300_000, () => clientSocket.destroy());
  });

  return new Promise((resolve, reject) => {
    // Listen on all interfaces (0.0.0.0) so containers can reach via host.docker.internal
    server.listen(0, '0.0.0.0', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        proxyPort = addr.port;
        proxyServer = server;
        console.log(`[https-proxy] CONNECT proxy listening on 0.0.0.0:${proxyPort}`);
        resolve(proxyPort);
      } else {
        reject(new Error('Failed to bind proxy'));
      }
    });
    server.on('error', reject);
  });
}

/** Stop the proxy. */
export function stopHttpsProxy(): void {
  if (proxyServer) {
    proxyServer.close();
    proxyServer = null;
    proxyPort = 0;
  }
}

/** Get the current proxy port (0 if not running). */
export function getHttpsProxyPort(): number {
  return proxyPort;
}
