/**
 * OCI image-selector validation for `shizuha up --image` (SCLI-559).
 *
 * A bad selector must fail BEFORE any HOME/XDG state is created. We reject
 * empty/whitespace/control-bearing, URL-shaped, and unreasonable-length values
 * with a field-specific single-line diagnostic, while preserving valid OCI
 * image references (e.g. `shizuha-agent-runtime:latest`, `ubuntu:24.04`,
 * `registry.example.com/team/app:v1.2@sha256:...`).
 */

/** Maximum accepted selector length in bytes (matches the QA 2048-byte probe). */
export const MAX_IMAGE_SELECTOR_LENGTH = 2048;

/**
 * Validate an OCI image selector.
 * @returns a human-readable error message, or null when the value is acceptable.
 */
export function validateImageSelector(image: string): string | null {
  if (typeof image !== 'string' || image.length === 0) {
    return 'must not be empty';
  }
  if (image.length > MAX_IMAGE_SELECTOR_LENGTH) {
    return `is too long (${image.length} bytes; max ${MAX_IMAGE_SELECTOR_LENGTH})`;
  }
  // Reject whitespace and control characters (space, tab, newline, NUL, ...).
  if (/[\s\x00-\x1F\x7F]/.test(image)) {
    return 'must not contain whitespace or control characters';
  }
  // Reject URL-shaped selectors (scheme://...), including http/https.
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(image)) {
    return 'must be an OCI image reference, not a URL';
  }
  // Reject values with characters that cannot appear in an OCI reference.
  if (!/^[a-zA-Z0-9._:@/\-]+$/.test(image)) {
    return 'contains unsupported characters';
  }
  return null;
}
