/**
 * Client-side image blob cache — WhatsApp-style.
 *
 * Workspace images are fetched once, converted to blob: URLs, and cached
 * in memory. Re-renders and scrolls use the cached blob URL — zero network
 * hits after the first load. Blob URLs are revoked on page unload.
 *
 * Usage: call cacheWorkspaceImages(containerEl) after dangerouslySetInnerHTML.
 * It finds <img> tags with workspace URLs and swaps src to blob: URLs.
 */

/** url → blob URL mapping (survives re-renders, lost on page refresh) */
const blobCache = new Map<string, string>();

/** URLs currently being fetched (prevents duplicate parallel fetches) */
const inflight = new Map<string, Promise<string>>();

/** Pattern matching workspace file URLs */
const WORKSPACE_URL_RE = /^\/v1\/workspace\//;

/**
 * Fetch an image URL, create a blob URL, and cache it.
 * Returns the blob URL. Deduplicates parallel requests for the same URL.
 */
function fetchAndCache(url: string): Promise<string> {
  const cached = blobCache.get(url);
  if (cached) return Promise.resolve(cached);

  const existing = inflight.get(url);
  if (existing) return existing;

  const promise = fetch(url)
    .then((res) => {
      if (!res.ok) throw new Error(`${res.status}`);
      return res.blob();
    })
    .then((blob) => {
      const blobUrl = URL.createObjectURL(blob);
      blobCache.set(url, blobUrl);
      inflight.delete(url);
      return blobUrl;
    })
    .catch(() => {
      inflight.delete(url);
      return url; // fallback to original URL on error
    });

  inflight.set(url, promise);
  return promise;
}

/**
 * Scan a container element for workspace <img> tags and swap their src
 * to cached blob URLs. Call this in useEffect after dangerouslySetInnerHTML.
 *
 * Images already using blob: URLs are skipped. Images not yet cached are
 * fetched in the background and swapped when ready.
 */
export function cacheWorkspaceImages(container: HTMLElement | null): void {
  if (!container) return;

  const imgs = container.querySelectorAll<HTMLImageElement>('img');
  for (const img of Array.from(imgs)) {
    const src = img.getAttribute('src') ?? '';
    if (!WORKSPACE_URL_RE.test(src)) continue;
    if (src.startsWith('blob:')) continue;

    // Already cached — swap immediately (synchronous, no flicker)
    const cached = blobCache.get(src);
    if (cached) {
      img.src = cached;
      continue;
    }

    // Not cached — fetch in background, swap when done
    fetchAndCache(src).then((blobUrl) => {
      // Only update if the img is still in the DOM and still has the same src
      if (img.isConnected && (img.getAttribute('src') === src || img.src === src)) {
        img.src = blobUrl;
      }
    });
  }
}

/**
 * Replace workspace URLs in an HTML string with cached blob URLs.
 * Call this on the output of renderMarkdown() BEFORE passing to
 * dangerouslySetInnerHTML. If the blob URL is already cached, the HTML
 * contains blob: URLs from the start — React sees stable HTML, never
 * recreates the <img> DOM elements, and no network request happens.
 *
 * Uncached URLs are left as-is; cacheWorkspaceImages() in useEffect
 * handles the initial fetch + swap for those.
 */
export function resolveHtmlBlobUrls(html: string): string {
  if (blobCache.size === 0) return html;
  return html.replace(
    /src="(\/v1\/workspace\/[^"]+)"/g,
    (match, url) => {
      const blob = blobCache.get(url);
      return blob ? `src="${blob}"` : match;
    },
  );
}

// Revoke all blob URLs on page unload to free memory
if (typeof window !== 'undefined') {
  window.addEventListener('unload', () => {
    for (const blobUrl of blobCache.values()) {
      URL.revokeObjectURL(blobUrl);
    }
  });
}
