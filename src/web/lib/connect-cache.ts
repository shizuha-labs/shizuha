/**
 * IndexedDB cache for Connect chat messages per agent / conversation.
 *
 * Purpose: instant render on page refresh. Without this the chat panel is
 * blank until either the first-load REST sync returns or the WS's
 * `missed_message` replay arrives — both are a few hundred ms on a warm
 * network, longer on mobile. With the cache, we render the last known
 * state immediately, then reconcile with server deltas as they arrive.
 *
 * Per MESSAGING_PROTOCOL.md § Client-Side Cache: the cache is NEVER the
 * source of truth — on conflict, Connect wins. The reconcile path is the
 * same as any other ingestion (`insertOrdered` on new_message /
 * missed_message). This module only persists and restores.
 *
 * Schema: one object store `messages_by_agent` keyed by agent_id. Value is
 * the full ordered ChatMessage[] for that agent, capped at a rolling
 * window. Keeping it per-agent (not per-message) makes reads + writes
 * whole-array, which matches how React uses the list anyway.
 */
import type { ChatMessage } from './types';

const DB_NAME = 'shizuha_connect_cache_v1';
const DB_VERSION = 1;
const STORE = 'messages_by_agent';
const MAX_MESSAGES_PER_AGENT = 500; // keep last 500; older messages re-hydrate via REST if user scrolls back

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch { resolve(null); }
  });
  return dbPromise;
}

/**
 * Load cached messages for an agent. Returns [] when no cache exists or
 * IndexedDB is unavailable. Non-fatal.
 */
export async function loadCachedMessages(agentId: string): Promise<ChatMessage[]> {
  const db = await openDb();
  if (!db) return [];
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(agentId);
      req.onsuccess = () => {
        const val = req.result;
        if (!Array.isArray(val)) resolve([]);
        else resolve(val as ChatMessage[]);
      };
      req.onerror = () => resolve([]);
    } catch { resolve([]); }
  });
}

/**
 * Persist the tail of `messages` (up to MAX_MESSAGES_PER_AGENT) for the
 * given agent. Writes whole-array to match the React render shape.
 * Fire-and-forget — callers should not await.
 */
export async function saveCachedMessages(agentId: string, messages: ChatMessage[]): Promise<void> {
  const db = await openDb();
  if (!db) return;
  // Strip pending local echoes from the cache — they're not server-confirmed
  // so re-hydrating them on refresh would re-render stale "sending…" state
  // that would never clear (the pending entry relies on an in-memory send
  // flow that doesn't survive refresh; if the send actually landed the
  // bridge's missed_message replay will bring it back).
  const tail = messages.filter((m) => !m.pending).slice(-MAX_MESSAGES_PER_AGENT);
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(tail, agentId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch { resolve(); }
  });
}

/** Delete cached messages for a specific agent (e.g. on "clear chat"). */
export async function clearCachedMessages(agentId: string): Promise<void> {
  const db = await openDb();
  if (!db) return;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(agentId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch { resolve(); }
  });
}

/** Clear the whole cache (e.g. on logout / daemon-epoch change). */
export async function clearAllCachedMessages(): Promise<void> {
  const db = await openDb();
  if (!db) return;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch { resolve(); }
  });
}
