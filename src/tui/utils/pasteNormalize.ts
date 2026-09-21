/**
 * SCLI-489: normalize pasted text so CRLF/CR/LF each become ONE logical
 * composer newline per source line break.
 *
 * A Windows/CRLF clipboard paste can be delivered in multiple input events
 * with the chunk boundary landing between `\r` and `\n`. Naively normalizing
 * each chunk independently turns a `\r\n` pair into `\n\n` (a 3-line paste
 * renders 5 lines). These helpers buffer a trailing `\r` and combine it with a
 * leading `\n` from the next chunk into a single newline.
 */

/** Strip control chars and normalize CRLF/CR to LF within one text chunk. */
export function sanitizePastedChunk(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\t/g, '    ')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}

/**
 * Stateful normalizer mirroring the composer's paste path. Feed each raw input
 * event via {@link push}; the returned string is what should be inserted.
 */
export class PasteNormalizer {
  private pendingCR = false;

  /** Feed one raw input event; returns the normalized text to insert. */
  push(input: string): string {
    let out = '';
    if (this.pendingCR) {
      this.pendingCR = false;
      // A trailing \r from the previous chunk: emit ONE newline, and if this
      // event starts with \n it was the second half of a split \r\n — consume
      // it so the pair stays a single newline.
      out = '\n';
      if (input.startsWith('\n')) {
        input = input.slice(1);
      }
    }
    if (input.endsWith('\r')) {
      input = input.slice(0, -1);
      this.pendingCR = true;
    }
    return out + sanitizePastedChunk(input);
  }

  reset(): void {
    this.pendingCR = false;
  }
}

/**
 * Pure end-to-end simulation of a multi-event paste. Returns the single
 * normalized draft the composer should hold after all chunks are fed in order.
 */
export function normalizePastedChunks(chunks: string[]): string {
  const normalizer = new PasteNormalizer();
  let out = '';
  for (const chunk of chunks) {
    out += normalizer.push(chunk);
  }
  return out;
}
