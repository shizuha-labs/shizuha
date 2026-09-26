/** Class of a transient retry banner. Same class replaces; it does not stack. */
export function retryBannerClass(content: string): string | null {
  const text = content.trim();
  if (!text.startsWith('↻')) return null;
  const typed = text.match(/API error \(([^)]+)\)/i);
  if (typed?.[1]) return typed[1].trim().toLowerCase();
  return 'retry';
}

/**
 * Resolved retries are not transcript. Once the provider is streaming again,
 * every ↻ line — including ones split by partial assistant text — leaves the
 * viewport. Terminal ✗ lines stay.
 */
export function withoutResolvedRetryBanners<T extends { role: string; content: string }>(
  entries: readonly T[],
): T[] {
  if (!entries.some((entry) => entry.role === 'system' && retryBannerClass(entry.content))) {
    return entries as T[];
  }
  return entries.filter((entry) => entry.role !== 'system' || !retryBannerClass(entry.content));
}
