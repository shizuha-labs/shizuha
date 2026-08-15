const REDACTION_MARKER = '[REDACTED]';

function splitConfigKey(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * Match secret-bearing configuration names without treating ordinary counters
 * such as `maxTokens` as credentials. The match is intentionally based on the
 * field name rather than a credential's current shape so new providers and MCP
 * integrations inherit the safe default automatically.
 */
export function isSensitiveConfigKey(key: string): boolean {
  const words = splitConfigKey(key);
  if (words.length === 0) return false;

  if (words.some((word) => [
    'password',
    'passphrase',
    'secret',
    'bearer',
    'credential',
    'credentials',
    'authorization',
  ].includes(word))) {
    return true;
  }

  const finalWord = words[words.length - 1];
  if (finalWord === 'token') return true;
  if (finalWord === 'key' && words.some((word) => [
    'api',
    'access',
    'client',
    'encryption',
    'private',
    'secret',
    'signing',
  ].includes(word))) {
    return true;
  }

  return false;
}

/** Return a JSON-serializable clone with every secret-named field censored. */
export function redactConfigForOutput(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactConfigForOutput(item));
  }
  if (!value || typeof value !== 'object') return value;

  return Object.fromEntries(Object.entries(value).map(([key, child]) => [
    key,
    isSensitiveConfigKey(key) && child != null
      ? REDACTION_MARKER
      : redactConfigForOutput(child),
  ]));
}
