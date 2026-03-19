/**
 * Parse a page range specification into an array of 0-indexed page numbers.
 *
 * Supported formats:
 *   "all"     -> all pages
 *   "3"       -> single page
 *   "1-5"     -> inclusive range
 *   "1,3,5-7" -> mixed list of singles and ranges
 *
 * @param spec - Page range string
 * @param totalPages - Total number of pages in the document
 * @returns Array of 0-indexed page numbers, sorted and deduplicated
 */
export function parsePageRange(spec: string, totalPages: number): number[] {
  const trimmed = spec.trim().toLowerCase();

  if (trimmed === 'all' || trimmed === '') {
    return Array.from({ length: totalPages }, (_, i) => i);
  }

  const pages = new Set<number>();
  const parts = trimmed.split(',');

  for (const part of parts) {
    const rangePart = part.trim();
    if (!rangePart) continue;

    const rangeMatch = rangePart.match(/^(\d+)\s*-\s*(\d+)$/);
    if (rangeMatch) {
      const start = parseInt(rangeMatch[1]!, 10);
      const end = parseInt(rangeMatch[2]!, 10);
      if (start < 1 || end < 1) {
        throw new Error(`Invalid page range "${rangePart}": page numbers must be >= 1`);
      }
      if (start > end) {
        throw new Error(`Invalid page range "${rangePart}": start must be <= end`);
      }
      if (start > totalPages) {
        throw new Error(`Invalid page range "${rangePart}": start page ${start} exceeds total pages ${totalPages}`);
      }
      const clampedEnd = Math.min(end, totalPages);
      for (let i = start; i <= clampedEnd; i++) {
        pages.add(i - 1); // convert to 0-indexed
      }
    } else {
      const num = parseInt(rangePart, 10);
      if (isNaN(num) || num < 1) {
        throw new Error(`Invalid page number "${rangePart}": must be a positive integer`);
      }
      if (num > totalPages) {
        throw new Error(`Page ${num} exceeds total pages ${totalPages}`);
      }
      pages.add(num - 1); // convert to 0-indexed
    }
  }

  return [...pages].sort((a, b) => a - b);
}
