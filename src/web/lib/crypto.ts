/**
 * Browser-side cryptographic identity for the dashboard.
 *
 * Uses Web Crypto API for:
 *  - Ed25519 keypair generation + storage (IndexedDB)
 *  - Message signing
 *  - X25519 key exchange + AES-256-GCM encryption (E2E)
 *
 * Keys persist in IndexedDB across sessions.
 */

const DB_NAME = 'shizuha-identity';
const STORE_NAME = 'keys';
const KEY_ID = 'user-keypair';

export interface BrowserKeypair {
  publicKey: string;   // hex
  privateKey: CryptoKey;
  publicKeyRaw: Uint8Array;
}

// ── IndexedDB helpers ──

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => { req.result.createObjectStore(STORE_NAME); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function storeKey(id: string, data: unknown): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(data, id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function loadKey(id: string): Promise<unknown | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(id);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

// ── Ed25519 (using Web Crypto where supported, fallback to tweetnacl) ──

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Get or create the user's Ed25519 keypair.
 * Stored in IndexedDB, persists across sessions.
 */
export async function getOrCreateKeypair(): Promise<{ publicKey: string; available: boolean }> {
  try {
    // Check if we already have a keypair
    const existing = await loadKey(KEY_ID) as { publicKey: string; privateKey: JsonWebKey } | null;
    if (existing?.publicKey) {
      return { publicKey: existing.publicKey, available: true };
    }

    // Generate new Ed25519 keypair via Web Crypto
    // Note: Ed25519 support in Web Crypto is recent (Chrome 113+, Firefox 130+)
    try {
      const keypair = await crypto.subtle.generateKey('Ed25519' as any, true, ['sign', 'verify']) as CryptoKeyPair;
      const pubRaw = await crypto.subtle.exportKey('raw', keypair.publicKey);
      const pubHex = toHex(new Uint8Array(pubRaw));
      const privJwk = await crypto.subtle.exportKey('jwk', keypair.privateKey);

      await storeKey(KEY_ID, { publicKey: pubHex, privateKey: privJwk });
      return { publicKey: pubHex, available: true };
    } catch {
      // Ed25519 not supported in this browser — use random ID as fallback
      const fallbackId = toHex(crypto.getRandomValues(new Uint8Array(32)));
      await storeKey(KEY_ID, { publicKey: fallbackId, privateKey: null, fallback: true });
      return { publicKey: fallbackId, available: false };
    }
  } catch {
    return { publicKey: '', available: false };
  }
}

/**
 * Sign a message with the user's private key.
 * Returns hex signature or null if signing unavailable.
 */
export async function signMessage(content: string, timestamp: number): Promise<string | null> {
  try {
    const stored = await loadKey(KEY_ID) as { privateKey: JsonWebKey | null; fallback?: boolean } | null;
    if (!stored?.privateKey || stored.fallback) return null;

    const privKey = await crypto.subtle.importKey('jwk', stored.privateKey, 'Ed25519' as any, false, ['sign']);
    const payload = new TextEncoder().encode(`${content}\n${timestamp}`);
    const sig = await crypto.subtle.sign('Ed25519' as any, privKey, payload);
    return toHex(new Uint8Array(sig));
  } catch {
    return null;
  }
}

/**
 * Check if cryptographic signing is available in this browser.
 */
export async function isSigningAvailable(): Promise<boolean> {
  try {
    const stored = await loadKey(KEY_ID) as { fallback?: boolean } | null;
    return !!stored && !stored.fallback;
  } catch {
    return false;
  }
}
