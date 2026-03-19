export interface PairedDevice {
  deviceId: string;
  deviceName: string;
  platform: string;
  tokenHash: string;
  createdAt: number;
  lastSeenAt: number;
  remoteIp: string;
}

export interface PendingCode {
  code: string;
  createdAt: number;
  expiresAt: number;
}

export interface DeviceStoreData {
  devices: PairedDevice[];
  pendingCodes: PendingCode[];
}
