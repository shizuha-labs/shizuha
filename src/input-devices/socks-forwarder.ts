/**
 * Local SOCKS5 auth forwarder.
 *
 * Chrome doesn't support authenticated SOCKS5. This creates a local
 * unauthenticated SOCKS5 proxy that forwards to a remote authenticated one.
 *
 * Chrome → localhost:LOCAL_PORT (no auth) → forwarder → remote:PORT (with auth) → internet
 *
 * The forwarder handles the SOCKS5 username/password handshake with the
 * remote server transparently. Chrome thinks it's talking to an
 * unauthenticated local proxy.
 */

import * as net from 'node:net';

export interface SocksForwarderConfig {
  /** Local port to listen on (Chrome connects here) */
  localPort?: number;
  /** Remote SOCKS5 proxy host */
  remoteHost: string;
  /** Remote SOCKS5 proxy port */
  remotePort: number;
  /** Username for remote proxy auth */
  username: string;
  /** Password for remote proxy auth */
  password: string;
}

export class SocksForwarder {
  private server: net.Server | null = null;
  private localPort: number;
  private config: SocksForwarderConfig;

  constructor(config: SocksForwarderConfig) {
    this.config = config;
    this.localPort = config.localPort ?? 0; // 0 = auto-assign
  }

  /** Start the forwarder. Returns the actual local port. */
  async start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = net.createServer((clientSocket) => {
        this.handleClient(clientSocket);
      });

      this.server.on('error', reject);

      this.server.listen(this.localPort, '127.0.0.1', () => {
        const addr = this.server!.address() as net.AddressInfo;
        this.localPort = addr.port;
        console.log(`[socks-forwarder] Listening on 127.0.0.1:${this.localPort} → ${this.config.remoteHost}:${this.config.remotePort}`);
        resolve(this.localPort);
      });
    });
  }

  private handleClient(client: net.Socket): void {
    let state: 'init' | 'request' | 'piping' = 'init';
    let remote: net.Socket | null = null;
    let pendingRequest: Buffer | null = null;

    client.once('data', (data) => {
      // Step 1: Client sends SOCKS5 method negotiation
      // [0x05, nMethods, ...methods]
      if (data[0] !== 0x05) {
        client.destroy();
        return;
      }

      // Reply: no auth required (we handle auth with remote)
      client.write(Buffer.from([0x05, 0x00]));
      state = 'request';

      client.once('data', (reqData) => {
        // Step 2: Client sends CONNECT request
        // [0x05, CMD, 0x00, ATYP, ADDR, PORT]
        pendingRequest = Buffer.from(reqData);

        // Step 3: Connect to remote SOCKS5 proxy
        remote = net.createConnection({
          host: this.config.remoteHost,
          port: this.config.remotePort,
        });

        remote.on('error', (err) => {
          console.error(`[socks-forwarder] Remote error: ${err.message}`);
          client.destroy();
        });

        client.on('error', () => remote?.destroy());

        let remoteState: 'method' | 'auth' | 'request' | 'pipe' = 'method';

        remote.on('connect', () => {
          // Step 4: SOCKS5 handshake with remote (username/password auth)
          remote!.write(Buffer.from([0x05, 0x01, 0x02])); // offer username/password method
        });

        remote.on('data', (rData) => {
          switch (remoteState) {
            case 'method': {
              // Remote accepted method 0x02 (username/password)
              if (rData[0] === 0x05 && rData[1] === 0x02) {
                // Send username/password
                const user = Buffer.from(this.config.username);
                const pass = Buffer.from(this.config.password);
                const auth = Buffer.alloc(3 + user.length + pass.length);
                auth[0] = 0x01; // version
                auth[1] = user.length;
                user.copy(auth, 2);
                auth[2 + user.length] = pass.length;
                pass.copy(auth, 3 + user.length);
                remote!.write(auth);
                remoteState = 'auth';
              } else {
                console.error('[socks-forwarder] Remote rejected auth method');
                client.destroy();
                remote!.destroy();
              }
              break;
            }
            case 'auth': {
              // Auth response: [0x01, STATUS] — 0x00 = success
              if (rData[1] === 0x00) {
                // Step 5: Forward the original client request to remote
                remote!.write(pendingRequest!);
                remoteState = 'request';
              } else {
                console.error('[socks-forwarder] Remote auth failed');
                // Send failure to client
                client.write(Buffer.from([0x05, 0x01, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
                client.destroy();
                remote!.destroy();
              }
              break;
            }
            case 'request': {
              // Step 6: Forward remote's response to client, then pipe
              client.write(rData);
              remoteState = 'pipe';
              state = 'piping';

              // Bidirectional pipe
              client.pipe(remote!);
              remote!.pipe(client);
              break;
            }
            case 'pipe': {
              // Already piping — this shouldn't happen (pipe handles it)
              break;
            }
          }
        });
      });
    });

    client.on('error', () => remote?.destroy());
    client.on('close', () => remote?.destroy());
  }

  async stop(): Promise<void> {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  get port(): number {
    return this.localPort;
  }
}
