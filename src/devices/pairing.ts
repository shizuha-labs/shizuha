import * as crypto from 'node:crypto';

// Unambiguous alphabet: no 0/O/1/I/l
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;

export const CODE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export function generatePairingCode(): string {
  const bytes = crypto.randomBytes(CODE_LENGTH);
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length];
  }
  return code;
}

export function formatCode(code: string): string {
  if (code.length !== 8) return code;
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

export function normalizeCode(input: string): string {
  return input.replace(/[-\s]/g, '').toUpperCase();
}

export function generateDeviceToken(): string {
  return crypto.randomBytes(36).toString('base64url');
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}
