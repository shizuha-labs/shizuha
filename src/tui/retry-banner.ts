/** Class of a transient retry banner. Same class replaces; it does not stack. */
export function retryBannerClass(content: string): string | null {
  const text = content.trim();
  if (!text.startsWith('↻')) return null;
  const typed = text.match(/API error \(([^)]+)\)/i);
  if (typed?.[1]) return typed[1].trim().toLowerCase();
  return 'retry';
}
