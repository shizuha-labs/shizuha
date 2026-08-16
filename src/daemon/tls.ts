/**
 * Auto-generated self-signed TLS certificate for the dashboard.
 *
 * On first run, generates a self-signed cert + key and stores them at
 * ~/.shizuha/tls/cert.pem and ~/.shizuha/tls/key.pem. Subsequent runs
 * reuse the existing certificate.
 *
 * This enables HTTPS for the dashboard, which is required for reliable
 * WebSocket connections in Firefox (Firefox throttles ws:// on HTTP pages).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

const TLS_DIR_NAME = 'tls';
const CERT_FILE = 'cert.pem';
const KEY_FILE = 'key.pem';

interface TlsCert {
  cert: string;
  key: string;
}

function getTlsDir(): string {
  return path.join(process.env['HOME'] ?? '~', '.shizuha', TLS_DIR_NAME);
}

/**
 * Get or generate a self-signed TLS certificate for the dashboard.
 * Returns { cert, key } PEM strings ready for Node's https server.
 */
export function ensureTlsCert(): TlsCert {
  const tlsDir = getTlsDir();
  const certPath = path.join(tlsDir, CERT_FILE);
  const keyPath = path.join(tlsDir, KEY_FILE);

  // Reuse existing cert if it exists
  if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    return {
      cert: fs.readFileSync(certPath, 'utf-8'),
      key: fs.readFileSync(keyPath, 'utf-8'),
    };
  }

  // Generate self-signed cert using Node's crypto module
  console.log('[tls] Generating self-signed certificate for dashboard HTTPS...');

  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
  });

  // Create a self-signed X.509 certificate
  // Node 20+ has crypto.X509Certificate but not cert generation.
  // We use the openssl-compatible approach via child_process as fallback,
  // or generate using the forge-like manual ASN.1 approach.
  // Simplest: use child_process with openssl if available, else use a minimal approach.

  try {
    const { execSync } = require('node:child_process');

    fs.mkdirSync(tlsDir, { recursive: true, mode: 0o700 });

    // Write private key
    const keyPem = privateKey.export({ type: 'sec1', format: 'pem' }) as string;
    fs.writeFileSync(keyPath, keyPem, { mode: 0o600 });

    // Generate self-signed cert with openssl
    execSync(
      `openssl req -new -x509 -key "${keyPath}" -out "${certPath}" -days 3650 -subj "/CN=shizuha-dashboard/O=Shizuha" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"`,
      { stdio: 'pipe', timeout: 10000 },
    );

    console.log('[tls] Certificate generated (valid for 10 years)');
    return {
      cert: fs.readFileSync(certPath, 'utf-8'),
      key: keyPem,
    };
  } catch (opensslErr) {
    // openssl not available — use Node's built-in self-signed cert generation (Node 22+)
    try {
      // Node 22+ has experimental generateCertificate
      const { generateCertificate } = require('node:tls') as { generateCertificate?: Function };
      if (typeof generateCertificate === 'function') {
        const result = generateCertificate({ subject: 'CN=shizuha-dashboard' }) as { cert: string; key: string };
        fs.mkdirSync(tlsDir, { recursive: true, mode: 0o700 });
        fs.writeFileSync(certPath, result.cert, { mode: 0o644 });
        fs.writeFileSync(keyPath, result.key, { mode: 0o600 });
        console.log('[tls] Certificate generated via Node TLS API');
        return result;
      }
    } catch { /* not available */ }

    // Last resort: generate with a minimal self-signed cert using SubtleCrypto
    // This won't work in all environments, so fall back to HTTP
    console.warn('[tls] Could not generate TLS certificate (openssl not found). Dashboard will use HTTP.');
    console.warn('[tls] Firefox WebSocket connections may be slow on HTTP. Install openssl to enable HTTPS.');
    throw new Error('TLS certificate generation failed');
  }
}
