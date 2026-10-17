/** Only authenticated provider-classified temporary failures carry admission deadlines. */
export interface ProviderDeferral {
  reason: 'residency_full' | 'provider_pool_dry' | 'model_leased' | 'maintenance';
  notBefore: number;
}

export function typedProviderDeferral(error: unknown, now = Date.now()): ProviderDeferral | null {
  if (!error || typeof error !== 'object') return null;
  const value = error as Record<string, unknown>;
  if (value.status !== 503 || typeof value.retryInMs !== 'number'
      || !Number.isFinite(value.retryInMs) || value.retryInMs <= 0) return null;
  const reason = value.residencyFull === true ? 'residency_full'
    : value.providerPoolDry === true ? 'provider_pool_dry'
      : value.modelLeased === true ? 'model_leased'
        : value.maintenance === true ? 'maintenance' : null;
  const notBefore = Math.ceil(now + value.retryInMs);
  return reason && Number.isSafeInteger(notBefore) ? { reason, notBefore } : null;
}
