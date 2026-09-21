const ID_USER_PATH = '/id/api/auth/user/';

export function voiceS2SInternalToken(): string {
  return (
    process.env['SHIZUHA_VOICE_INTERNAL_TOKEN']
    || process.env['VOICE_INTERNAL_TOKEN']
    || ''
  ).trim();
}

export function isLoopbackAddress(ip: string): boolean {
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

export async function verifyVoiceS2SToken(
  token: string,
  opts?: { fetchImpl?: typeof fetch; platformUrl?: string },
): Promise<boolean> {
  const trimmed = token.trim();
  if (!trimmed) return false;
  const internal = voiceS2SInternalToken();
  if (internal && trimmed === internal) return true;

  const platform = (opts?.platformUrl || process.env['SHIZUHA_PLATFORM_URL'] || '')
    .replace(/\/+$/, '');
  if (!platform) return false;
  const fetchImpl = opts?.fetchImpl ?? fetch;
  try {
    const resp = await fetchImpl(`${platform}${ID_USER_PATH}`, {
      headers: { Authorization: `Bearer ${trimmed}` },
    });
    return resp.ok;
  } catch {
    return false;
  }
}
