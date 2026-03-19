/**
 * Cryptographic Identity — Ed25519 signing + X25519 encryption for messages.
 *
 * Three layers:
 *  1. Identity labels (OpenClaw-style, always on)
 *  2. Message signing (Ed25519, opt-in per agent)
 *  3. E2E encryption (X25519 ECDH + AES-256-GCM, opt-in per agent)
 *
 * Key storage:
 *  - Browser: IndexedDB (via Web Crypto API)
 *  - Server: workspace/.identity/ directory (per-agent keypair)
 *  - Dashboard: credentials store
 */

import * as crypto from 'node:crypto';

// ── Types ──

export interface UserIdentity {
  /** Display name (from login, channel, or key registration) */
  displayName: string;
  /** Unique identifier (username, phone, platform ID) */
  userId: string;
  /** Source channel */
  source: 'dashboard' | 'telegram' | 'discord' | 'whatsapp' | 'slack' | 'signal' | 'line' | 'imessage' | 'api' | 'webhook' | 'agent';
  /** Ed25519 public key (hex) — present if signing is enabled */
  publicKey?: string;
  /** Is this identity cryptographically verified (signature checked)? */
  verified?: boolean;
}

export interface SignedMessage {
  content: string;
  timestamp: number;
  publicKey: string;         // Ed25519 public key (hex)
  signature: string;         // Ed25519 signature (hex)
}

export interface EncryptedMessage {
  ciphertext: string;        // AES-256-GCM ciphertext (base64)
  nonce: string;             // 12-byte nonce (base64)
  tag: string;               // 16-byte auth tag (base64)
  ephemeralPubKey: string;   // X25519 ephemeral public key (hex)
  senderPubKey: string;      // Ed25519 sender public key (hex)
  signature: string;         // Signature over ciphertext+nonce (hex)
}

// ── Ed25519 Keypair Generation ──

export interface Keypair {
  publicKey: string;   // hex
  privateKey: string;  // hex (PEM-encoded internally)
  publicKeyPem: string;
  privateKeyPem: string;
}

export function generateKeypair(): Keypair {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  // Raw public key: strip 12-byte Ed25519 SPKI prefix from DER
  const spkiDer = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  const rawPub = spkiDer.subarray(12);
  return {
    publicKey: rawPub.toString('hex'),
    privateKey: privPem, // Keep PEM for crypto.sign()
    publicKeyPem: pubPem,
    privateKeyPem: privPem,
  };
}

// ── Ed25519 Signing ──

export function signMessage(content: string, timestamp: number, privateKeyPem: string): string {
  const payload = `${content}\n${timestamp}`;
  const key = crypto.createPrivateKey(privateKeyPem);
  const sig = crypto.sign(null, Buffer.from(payload, 'utf8'), key);
  return sig.toString('hex');
}

export function verifySignature(content: string, timestamp: number, publicKeyHex: string, signatureHex: string): boolean {
  try {
    const payload = `${content}\n${timestamp}`;
    // Reconstruct SPKI DER from raw public key
    const rawKey = Buffer.from(publicKeyHex, 'hex');
    const spkiPrefix = Buffer.from('302a300506032b6570032100', 'hex'); // Ed25519 SPKI header
    const spkiDer = Buffer.concat([spkiPrefix, rawKey]);
    const pubKey = crypto.createPublicKey({ key: spkiDer, format: 'der', type: 'spki' });
    const sig = Buffer.from(signatureHex, 'hex');
    return crypto.verify(null, Buffer.from(payload, 'utf8'), pubKey, sig);
  } catch {
    return false;
  }
}

// ── X25519 ECDH + AES-256-GCM Encryption ──

export function generateX25519Keypair(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  const pubDer = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  const privDer = privateKey.export({ type: 'pkcs8', format: 'der' }) as Buffer;
  // Raw X25519 public key is last 32 bytes of SPKI DER
  const rawPub = pubDer.subarray(pubDer.length - 32);
  return {
    publicKey: rawPub.toString('hex'),
    privateKey: privDer.toString('hex'),
  };
}

function deriveSharedSecret(myPrivateKeyDer: string, theirPublicKeyHex: string): Buffer {
  // Reconstruct X25519 PKCS8 DER for private key
  const privDer = Buffer.from(myPrivateKeyDer, 'hex');
  const myPrivKey = crypto.createPrivateKey({ key: privDer, format: 'der', type: 'pkcs8' });

  // Reconstruct X25519 SPKI DER for public key
  const rawPub = Buffer.from(theirPublicKeyHex, 'hex');
  const x25519SpkiPrefix = Buffer.from('302a300506032b656e032100', 'hex');
  const theirPubDer = Buffer.concat([x25519SpkiPrefix, rawPub]);
  const theirPubKey = crypto.createPublicKey({ key: theirPubDer, format: 'der', type: 'spki' });

  return crypto.diffieHellman({ privateKey: myPrivKey, publicKey: theirPubKey });
}

export function encryptMessage(
  content: string,
  recipientX25519PubKey: string,
  senderEd25519PrivKeyPem: string,
  senderEd25519PubKeyHex: string,
): EncryptedMessage {
  // Generate ephemeral X25519 keypair for this message
  const ephemeral = generateX25519Keypair();

  // ECDH: ephemeral private + recipient public → shared secret
  const shared = deriveSharedSecret(ephemeral.privateKey, recipientX25519PubKey);

  // Derive AES key from shared secret via HKDF
  const aesKey = crypto.hkdfSync('sha256', shared, '', 'shizuha-e2e-v1', 32);

  // Encrypt with AES-256-GCM
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(aesKey), nonce);
  const encrypted = Buffer.concat([cipher.update(content, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  // Sign the ciphertext (non-repudiation)
  const sigPayload = `${encrypted.toString('base64')}\n${nonce.toString('base64')}`;
  const signature = signMessage(sigPayload, Date.now(), senderEd25519PrivKeyPem);

  return {
    ciphertext: encrypted.toString('base64'),
    nonce: nonce.toString('base64'),
    tag: tag.toString('base64'),
    ephemeralPubKey: ephemeral.publicKey,
    senderPubKey: senderEd25519PubKeyHex,
    signature,
  };
}

export function decryptMessage(
  msg: EncryptedMessage,
  recipientX25519PrivKey: string,
): string {
  // ECDH: recipient private + ephemeral public → shared secret
  const shared = deriveSharedSecret(recipientX25519PrivKey, msg.ephemeralPubKey);

  // Derive AES key
  const aesKey = crypto.hkdfSync('sha256', shared, '', 'shizuha-e2e-v1', 32);

  // Decrypt
  const nonce = Buffer.from(msg.nonce, 'base64');
  const ciphertext = Buffer.from(msg.ciphertext, 'base64');
  const tag = Buffer.from(msg.tag, 'base64');

  const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(aesKey), nonce);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString('utf8');
}

// ── Identity Label Builder ──

export function buildIdentityPrefix(identity: UserIdentity): string {
  const parts: string[] = [];

  if (identity.displayName) {
    parts.push(`name: "${identity.displayName}"`);
  }
  if (identity.userId) {
    parts.push(`id: "${identity.userId}"`);
  }
  parts.push(`source: ${identity.source}`);
  if (identity.verified) {
    parts.push(`verified: true (Ed25519)`);
  }

  return `[Sender: ${parts.join(', ')}]`;
}

// ── Agent Keypair Management ──

import * as fs from 'node:fs';
import * as path from 'node:path';

export function loadOrCreateAgentKeypair(workspaceDir: string): Keypair & { x25519Public: string; x25519Private: string } {
  const identityDir = path.join(workspaceDir, '.identity');
  const keypairPath = path.join(identityDir, 'agent-keypair.json');

  if (fs.existsSync(keypairPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(keypairPath, 'utf-8'));
      if (data.publicKey && data.privateKey && data.x25519Public && data.x25519Private) {
        return data;
      }
    } catch { /* regenerate */ }
  }

  // Generate new keypair
  fs.mkdirSync(identityDir, { recursive: true });
  const ed = generateKeypair();
  const x = generateX25519Keypair();

  const keypair = {
    ...ed,
    x25519Public: x.publicKey,
    x25519Private: x.privateKey,
  };

  fs.writeFileSync(keypairPath, JSON.stringify(keypair, null, 2), { mode: 0o600 });
  return keypair;
}
