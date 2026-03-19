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

export function readDeviceStore(): DeviceStoreData {
  try {
    const raw = fs.readFileSync(devicesFilePath(), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<DeviceStoreData>;
    return {
      devices: Array.isArray(parsed.devices) ? parsed.devices : [],
      pendingCodes: Array.isArray(parsed.pendingCodes) ? parsed.pendingCodes : [],
    };
  } catch {
    return emptyStore();
  }
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
