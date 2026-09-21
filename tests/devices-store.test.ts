import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  readDeviceStore,
  listDevices,
  DeviceStoreCorruptError,
} from '../src/devices/store.js';

/**
 * SCLI-422 — a present-but-corrupt device registry must never be rendered as
 * an empty registry. Missing registry = legitimate first-run empty; present
 * but unreadable/invalid JSON/invalid root = bounded actionable error.
 */
describe('devices store integrity (SCLI-422)', () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'scli422-'));
    vi.stubEnv('HOME', home);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(home, { recursive: true, force: true });
  });

  const devicesFile = () => path.join(home, '.shizuha', 'devices.json');

  it('missing registry is a legitimate first-run empty store', () => {
    expect(readDeviceStore()).toEqual({ devices: [], pendingCodes: [] });
    expect(listDevices()).toEqual([]);
  });

  it('valid empty-registry fixture is preserved', () => {
    fs.mkdirSync(path.dirname(devicesFile()), { recursive: true });
    fs.writeFileSync(devicesFile(), JSON.stringify({ devices: [], pendingCodes: [] }, null, 2));
    expect(readDeviceStore()).toEqual({ devices: [], pendingCodes: [] });
    expect(listDevices()).toEqual([]);
  });

  it('empty file (0 bytes) is corrupt, not an empty registry', () => {
    fs.mkdirSync(path.dirname(devicesFile()), { recursive: true });
    fs.writeFileSync(devicesFile(), '');
    expect(() => readDeviceStore()).toThrow(DeviceStoreCorruptError);
    expect(() => listDevices()).toThrow(DeviceStoreCorruptError);
  });

  it('truncated JSON is corrupt, not an empty registry', () => {
    fs.mkdirSync(path.dirname(devicesFile()), { recursive: true });
    fs.writeFileSync(devicesFile(), '{');
    expect(() => readDeviceStore()).toThrow(DeviceStoreCorruptError);
    expect(() => listDevices()).toThrow(DeviceStoreCorruptError);
  });

  it('oversized syntactically invalid JSON is corrupt', () => {
    fs.mkdirSync(path.dirname(devicesFile()), { recursive: true });
    fs.writeFileSync(devicesFile(), '{'.repeat(1024 * 1024));
    expect(() => readDeviceStore()).toThrow(DeviceStoreCorruptError);
    expect(() => listDevices()).toThrow(DeviceStoreCorruptError);
  });

  it.each([
    ['null root', 'null'],
    ['scalar root', '42'],
    ['string root', '"hello"'],
    ['array root', '[]'],
    ['object with non-array devices', JSON.stringify({ devices: 'nope', pendingCodes: [] })],
    ['object with non-array pendingCodes', JSON.stringify({ devices: [], pendingCodes: 7 })],
  ])('invalid root shape (%s) is corrupt', (_label, raw) => {
    fs.mkdirSync(path.dirname(devicesFile()), { recursive: true });
    fs.writeFileSync(devicesFile(), raw);
    expect(() => readDeviceStore()).toThrow(DeviceStoreCorruptError);
    expect(() => listDevices()).toThrow(DeviceStoreCorruptError);
  });

  it('corrupt diagnostic names the file and recovery class, not contents', () => {
    fs.mkdirSync(path.dirname(devicesFile()), { recursive: true });
    fs.writeFileSync(devicesFile(), '{');
    try {
      readDeviceStore();
      expect.unreachable('should have thrown');
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain(devicesFile());
      expect(msg).toMatch(/not valid JSON|unreadable|not a valid device-store object/);
      expect(msg).toMatch(/Recover by removing or repairing/);
      // Secret-safe: must not echo the corrupt contents.
      expect(msg).not.toContain('{');
    }
  });

  it('valid populated registry still lists devices', () => {
    fs.mkdirSync(path.dirname(devicesFile()), { recursive: true });
    fs.writeFileSync(
      devicesFile(),
      JSON.stringify({
        devices: [{ deviceId: 'd1', deviceName: 'Phone', platform: 'android', tokenHash: 'h', createdAt: 1, lastSeenAt: 1, remoteIp: '127.0.0.1' }],
        pendingCodes: [],
      }),
    );
    expect(listDevices()).toHaveLength(1);
    expect(listDevices()[0]!.deviceName).toBe('Phone');
  });
});
