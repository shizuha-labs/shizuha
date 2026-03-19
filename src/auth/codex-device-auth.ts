/**
 * Codex Device Auth Flow — authenticate with OpenAI via device code.
 *
 * Uses the same OAuth client_id and endpoints as Codex CLI, Hermes, and OpenClaw.
 * Credentials are stored in ~/.shizuha/credentials.json (never writes to ~/.codex/).
 *
 * Flow:
 *   1. POST auth.openai.com/api/accounts/deviceauth/usercode → get device_auth_id + user_code
 *   2. User visits https://auth.openai.com/codex/device and enters the code
 *   3. Poll auth.openai.com/api/accounts/deviceauth/token until authorized
 *   4. Exchange authorization code for access_token + refresh_token
 *   5. Save to ~/.shizuha/credentials.json
 */

import { saveCodexAccount } from '../config/credentials.js';

const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const DEVICE_CODE_URL = 'https://auth.openai.com/api/accounts/deviceauth/usercode';
const DEVICE_TOKEN_URL = 'https://auth.openai.com/api/accounts/deviceauth/token';
const TOKEN_EXCHANGE_URL = 'https://auth.openai.com/oauth/token';
const DEVICE_AUTH_CALLBACK_URI = 'https://auth.openai.com/deviceauth/callback';
const DEVICE_AUTH_PAGE = 'https://auth.openai.com/codex/device';

const POLL_INTERVAL_MS = 3000;
const MAX_POLL_DURATION_MS = 15 * 60 * 1000; // 15 minutes

/** Decode JWT payload without verification (for email/account_id extraction) */
function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const raw = parts[1]!.replace(/-/g, '+').replace(/_/g, '/');
    const padLen = (4 - (raw.length % 4)) % 4;
    return JSON.parse(Buffer.from(raw + '='.repeat(padLen), 'base64').toString('utf-8'));
  } catch {
    return null;
  }
}

interface DeviceCodeResponse {
  user_code: string;
  device_auth_id: string;
  interval?: number;
}

interface DeviceTokenResponse {
  authorization_code?: string;
  code_verifier?: string;
  error?: string;
}

interface TokenExchangeResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  token_type?: string;
}

export interface DeviceAuthCallbacks {
  onUserCode: (code: string, verificationUrl: string) => void;
  onPolling: () => void;
  onSuccess: (email: string) => void;
  onError: (error: string) => void;
}

/**
 * Run the full device auth flow for Codex OAuth.
 * Returns the email of the authenticated account.
 */
export async function codexDeviceAuth(callbacks: DeviceAuthCallbacks): Promise<string> {
  // Step 1: Request device code
  const codeResp = await fetch(DEVICE_CODE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: CLIENT_ID }),
  });

  if (!codeResp.ok) {
    const text = await codeResp.text().catch(() => '');
    throw new Error(`Failed to request device code: ${codeResp.status} ${text}`);
  }

  const codeData = await codeResp.json() as DeviceCodeResponse;
  const { user_code, device_auth_id } = codeData;

  if (!user_code || !device_auth_id) {
    throw new Error('Invalid device code response');
  }

  // Step 2: Show user code
  callbacks.onUserCode(user_code, DEVICE_AUTH_PAGE);

  // Step 3: Poll for authorization
  const startTime = Date.now();

  while (Date.now() - startTime < MAX_POLL_DURATION_MS) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    callbacks.onPolling();

    const pollResp = await fetch(DEVICE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        device_auth_id,
        user_code,
      }),
    });

    if (!pollResp.ok) {
      // Not yet authorized — keep polling
      continue;
    }

    const pollData = await pollResp.json() as DeviceTokenResponse;

    if (pollData.error) {
      if (pollData.error === 'authorization_pending' || pollData.error === 'slow_down') {
        continue;
      }
      throw new Error(`Device auth error: ${pollData.error}`);
    }

    if (pollData.authorization_code) {
      // Step 4: Exchange authorization code for tokens
      const tokenResp = await fetch(TOKEN_EXCHANGE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: pollData.authorization_code,
          redirect_uri: DEVICE_AUTH_CALLBACK_URI,
          client_id: CLIENT_ID,
          ...(pollData.code_verifier ? { code_verifier: pollData.code_verifier } : {}),
        }),
      });

      if (!tokenResp.ok) {
        const text = await tokenResp.text().catch(() => '');
        throw new Error(`Token exchange failed: ${tokenResp.status} ${text}`);
      }

      const tokenData = await tokenResp.json() as TokenExchangeResponse;

      if (!tokenData.access_token) {
        throw new Error('Token exchange returned no access_token');
      }

      // Extract email and account_id from JWT
      const jwt = decodeJwtPayload(tokenData.access_token);

      // OpenAI JWT stores user info in various claims depending on auth provider:
      // - Direct: jwt.email
      // - OpenAI profile: jwt['https://api.openai.com/profile'].email
      // - Auth block: jwt['https://api.openai.com/auth'].user_id
      // - Google OAuth: sub is 'google-oauth2|...' — email is in profile claim
      const profileClaim = jwt?.['https://api.openai.com/profile'] as Record<string, string> | undefined;
      const authClaim = jwt?.['https://api.openai.com/auth'] as Record<string, string> | undefined;
      const email = (jwt?.email as string)
        ?? profileClaim?.email
        ?? authClaim?.email
        ?? '';

      // If JWT doesn't contain email, try fetching from /me endpoint
      let resolvedEmail = email;
      if (!resolvedEmail || resolvedEmail.includes('|')) {
        try {
          const meResp = await fetch('https://api.openai.com/v1/me', {
            headers: { Authorization: `Bearer ${tokenData.access_token}` },
          });
          if (meResp.ok) {
            const meData = await meResp.json() as Record<string, unknown>;
            const meEmails = meData.emails as Array<{ email: string; verified: boolean }> | undefined;
            const primary = meEmails?.find((e) => e.verified)?.email ?? meEmails?.[0]?.email;
            if (primary) resolvedEmail = primary;
          }
        } catch { /* best effort — keep what we have */ }
      }

      // Final fallback to sub
      if (!resolvedEmail) {
        resolvedEmail = (jwt?.sub as string) ?? 'unknown';
      }

      const accountId = (jwt?.account_id as string)
        ?? authClaim?.chatgpt_account_id
        ?? authClaim?.account_id
        ?? '';

      // Step 5: Persist to ~/.shizuha/credentials.json
      saveCodexAccount({
        email: resolvedEmail,
        accessToken: tokenData.access_token,
        refreshToken: tokenData.refresh_token ?? '',
        idToken: tokenData.id_token,
        accountId,
        addedAt: new Date().toISOString(),
      });

      callbacks.onSuccess(resolvedEmail);
      return resolvedEmail;
    }
  }

  throw new Error('Device auth timed out after 15 minutes');
}
