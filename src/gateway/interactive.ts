/**
 * Interactive Payloads — structured responses that channels render as
 * buttons, polls, or other interactive elements (Telegram, Discord, Slack).
 *
 * GAP A: OpenClaw parity — agents can send interactive UI elements.
 */

// ── Types ──

export interface InteractiveButton {
  text: string;
  callbackData: string;
  style?: 'default' | 'primary' | 'destructive';
}

export interface InteractivePoll {
  question: string;
  options: string[];
  maxSelections?: number;
  anonymous?: boolean;
}

export interface InteractivePayload {
  /** Rows of buttons — each inner array is a row */
  buttons?: InteractiveButton[][];
  /** A poll (mutually exclusive with buttons in most channels) */
  poll?: InteractivePoll;
}

/**
 * Validate an InteractivePayload, returning a cleaned version or null if invalid.
 */
export function validateInteractivePayload(raw: unknown): InteractivePayload | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;

  const result: InteractivePayload = {};

  // Validate buttons
  if (Array.isArray(obj.buttons)) {
    const rows: InteractiveButton[][] = [];
    for (const row of obj.buttons) {
      if (!Array.isArray(row)) continue;
      const validRow: InteractiveButton[] = [];
      for (const btn of row) {
        if (btn && typeof btn === 'object' && typeof (btn as any).text === 'string' && typeof (btn as any).callbackData === 'string') {
          const b: InteractiveButton = {
            text: String((btn as any).text).slice(0, 64),
            callbackData: String((btn as any).callbackData).slice(0, 256),
          };
          if ((btn as any).style === 'primary' || (btn as any).style === 'destructive') {
            b.style = (btn as any).style;
          }
          validRow.push(b);
        }
      }
      if (validRow.length > 0) rows.push(validRow);
    }
    if (rows.length > 0) result.buttons = rows;
  }

  // Validate poll
  if (obj.poll && typeof obj.poll === 'object') {
    const p = obj.poll as Record<string, unknown>;
    if (typeof p.question === 'string' && Array.isArray(p.options)) {
      const options = (p.options as unknown[])
        .filter((o): o is string => typeof o === 'string' && o.length > 0)
        .slice(0, 10)
        .map(o => o.slice(0, 200));
      if (options.length >= 2) {
        result.poll = {
          question: String(p.question).slice(0, 300),
          options,
          maxSelections: typeof p.maxSelections === 'number' ? Math.min(p.maxSelections, options.length) : 1,
          anonymous: p.anonymous === true,
        };
      }
    }
  }

  if (!result.buttons && !result.poll) return null;
  return result;
}
