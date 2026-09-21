import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type { PairedDevice, PendingCode, DeviceStoreData } from './types.js';
import { CODE_TTL_MS } from './pairing.js';

function devicesDir(): string {
  return path.join(process.env['HOME'] ?? '~', '.shizuha');
}

function devicesFilePath(): string {
  return path.join(devicesDir(), 'devices.json');
}

function emptyStore(): DeviceStoreData {
  return { devices: [], pendingCodes: [] };
}

/**
 * SCLI-422 — a present-but-corrupt device registry must never be rendered as
 * an empty registry. Raised when devices.json exists but cannot be read or
 * parsed as a valid DeviceStoreData root. The message names the file and the
 * recovery class without printing file contents or a raw stack.
 */
export class DeviceStoreCorruptError extends Error {
  constructor(filePath: string, reason: string) {
    super(
      `Device store ${filePath} is ${reason}. ` +
        `Recover by removing or repairing this file — paired devices will need to be re-paired.`,
    );
    this.name = 'DeviceStoreCorruptError';
  }
}

function isValidStoreRoot(value: unknown): value is Partial<DeviceStoreData> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const root = value as Record<string, unknown>;
  if ('devices' in root && !Array.isArray(root.devices)) return false;
  if ('pendingCodes' in root && !Array.isArray(root.pendingCodes)) return false;
  return true;
}

export function readDeviceStore(): DeviceStoreData {
  const filePath = devicesFilePath();
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // No registry yet — legitimate first-run empty store.
      return emptyStore();
    }
    throw new DeviceStoreCorruptError(filePath, 'unreadable');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new DeviceStoreCorruptError(filePath, 'not valid JSON');
  }
  if (!isValidStoreRoot(parsed)) {
    throw new DeviceStoreCorruptError(filePath, 'not a valid device-store object');
  }
  const root = parsed as Partial<DeviceStoreData>;
  return {
    devices: Array.isArray(root.devices) ? root.devices : [],
    pendingCodes: Array.isArray(root.pendingCodes) ? root.pendingCodes : [],
  };
}

function writeDeviceStore(store: DeviceStoreData): void {
  const dir = devicesDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const filePath = devicesFilePath();
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, filePath);
}

/** Prune expired pending codes */
function pruneExpired(codes: PendingCode[]): PendingCode[] {
  const now = Date.now();
  return codes.filter((c) => c.expiresAt > now);
}

export function addPendingCode(code: PendingCode): void {
  const store = readDeviceStore();
  store.pendingCodes = pruneExpired(store.pendingCodes);
  // Limit max pending codes to 10
  if (store.pendingCodes.length >= 10) {
    store.pendingCodes = store.pendingCodes.slice(-9);
  }
  store.pendingCodes.push(code);
  writeDeviceStore(store);
}

export function consumePendingCode(code: string): PendingCode | null {
  const store = readDeviceStore();
  store.pendingCodes = pruneExpired(store.pendingCodes);
  const idx = store.pendingCodes.findIndex((c) => c.code === code);
  if (idx < 0) return null;
  const [found] = store.pendingCodes.splice(idx, 1);
  writeDeviceStore(store);
  return found!;
}

/** Drop a pending pairing code without consuming it (Ctrl+C / cancel cleanup). */
export function clearPendingCode(code: string): boolean {
  const store = readDeviceStore();
  const before = store.pendingCodes.length;
  store.pendingCodes = store.pendingCodes.filter((c) => c.code !== code);
  if (store.pendingCodes.length === before) return false;
  writeDeviceStore(store);
  return true;
}

export function addDevice(device: PairedDevice): void {
  const store = readDeviceStore();
  store.devices.push(device);
  writeDeviceStore(store);
}

export function removeDevice(deviceId: string): boolean {
  const store = readDeviceStore();
  const before = store.devices.length;
  store.devices = store.devices.filter((d) => d.deviceId !== deviceId);
  if (store.devices.length === before) return false;
  writeDeviceStore(store);
  return true;
}

export function findDeviceByTokenHash(hash: string): PairedDevice | null {
  const store = readDeviceStore();
  return store.devices.find((d) => d.tokenHash === hash) ?? null;
}

export function updateLastSeen(deviceId: string, timestamp: number, ip?: string): void {
  const store = readDeviceStore();
  const device = store.devices.find((d) => d.deviceId === deviceId);
  if (!device) return;
  device.lastSeenAt = timestamp;
  if (ip) device.remoteIp = ip;
  writeDeviceStore(store);
}

export function rotateDeviceToken(deviceId: string, newTokenHash: string): boolean {
  const store = readDeviceStore();
  const device = store.devices.find((d) => d.deviceId === deviceId);
  if (!device) return false;
  device.tokenHash = newTokenHash;
  writeDeviceStore(store);
  return true;
}

export function listDevices(): PairedDevice[] {
  return readDeviceStore().devices;
}

export function generateDeviceId(): string {
  return crypto.randomUUID();
}
