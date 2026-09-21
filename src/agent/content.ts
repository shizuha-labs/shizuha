import type { Message, ReasoningContent } from './types.js';

/** Visible assistant text only. Excludes reasoning/tool blocks by design. */
export function visibleTextFromContent(content: Message['content']): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

/** Provider reasoning text, used for diagnostics and thinking-capable models only. */
export function reasoningTextFromContent(content: Message['content']): string {
  if (!Array.isArray(content)) return '';
  return content
    .filter((block): block is ReasoningContent => block.type === 'reasoning')
    .map((block) => {
      if (typeof block.rawContent === 'string' && block.rawContent.trim()) return block.rawContent.trim();
      return Array.isArray(block.summary)
        ? block.summary.map((entry: { text: string }) => entry.text).filter(Boolean).join('\n')
        : '';
    })
    .filter(Boolean)
    .join('\n')
    .trim();
}

export function strippedVisibleTextFromContent(content: Message['content']): string {
  return visibleTextFromContent(content).replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

export function hasVisibleAssistantText(content: Message['content']): boolean {
  return strippedVisibleTextFromContent(content).length > 0;
}

/**
 * True when the assistant only narrated intended next work instead of answering
 * or actually calling a tool. These are not valid terminal answers for an agent
 * loop because the UI will otherwise go idle after "Let me search..." forever.
 */
export function isProgressOnlyAssistantText(text: string): boolean {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return false;

  const lower = normalized.toLowerCase();
  // `let me know` is a CLOSER inviting user input, not intent to act — without
  // the exclusion, "let me know if you want me to check X" reads as intent.
  const actionVerb = '(?:check|search|inspect|look(?:\\s+up|\\s+for|\\s+at)?|run|open|read|list|query|call|fetch|pull|load|verify|test|debug|investigate|trace|diagnose|probe|follow|try|use|execute|access|find|write|create|build|apply|commit|push|deploy)';
  const intentLead = "(?:let me(?! know)|i(?:'|\\u2019)?ll|i will|i(?:'|\\u2019)?m going to|i am going to|now i(?:'|\\u2019)?ll|next i(?:'|\\u2019)?ll)";
  const futureIntent = new RegExp(
    `\\b${intentLead}\\b.{0,160}\\b${actionVerb}\\b`,
    'i',
  );

  if (normalized.length > 700) {
    // The old hard cap (`>700 → false`) assumed long text means a substantive
    // answer. Live counter-example, 2026-08-05 (operator: "it doesn't show the
    // buffering animation so likely not doing anything .. most likely it died
    // .. this needs serious investigation"): a 2,720-char think-aloud turn —
    // "Let me reconsider the two-repo flow… Let me write the workflow file…
    // Let me first check: … Let me check for a crates mirror" — ended with NO
    // tool call, the classifier said not-progress-only because of its length,
    // no recovery fired, and the session sat idle for ~55 minutes until a
    // human noticed. Length is not the signal; the ENDING is. A long turn
    // whose FINAL sentence announces an action it never took is a stall.
    const tail = normalized.slice(-260);
    const sentences = tail.split(/(?<=[.!?])\s+/).map((part) => part.trim()).filter(Boolean);
    const last = sentences[sentences.length - 1] ?? '';
    return futureIntent.test(last);
  }

  if (futureIntent.test(lower)) return true;

  const terseProgress = new RegExp(
    `^(?:ok(?:ay)?|good|great|sure|understood|got it)[,.! ]+.{0,160}\\b(?:let me(?! know)|i(?:'|\\u2019)?ll|i will|i(?:'|\\u2019)?m going to|i am going to)\\b.{0,160}\\b${actionVerb}\\b`,
    'i',
  );
  if (terseProgress.test(lower)) return true;

  // DeepSeek sometimes omits the subject entirely and ends with a present-
  // participle progress line, e.g. "Creating the teaching module now — rich
  // lessons...".  Requiring "now"/"next" keeps substantive gerund-led
  // explanations ("Creating indexes reduces latency") out of this guard.
  // Optional `re-` covers "Re-calling the tool live:" (shizuha1 2026-09-11:
  // GLM EOS'd after that closer; `calling` is in the list but the hyphenated
  // prefix made every gerund/colon rule miss, so the TUI treated narration as
  // a finished answer).
  const gerundBody = 'checking|searching|inspecting|looking|running|opening|reading|listing|querying|calling|fetching|pulling|loading|verifying|testing|debugging|investigating|trying|using|executing|accessing|finding|writing|creating|building|applying|committing|pushing|deploying';
  const gerunds = `(?:re-)?(?:${gerundBody})`;
  const gerundProgress = new RegExp(
    `^(?:${gerunds})\\b.{0,240}\\b(?:now|next)\\b`,
    'i',
  );
  if (gerundProgress.test(normalized)) return true;

  // shizuha1 2026-09-10: "Now pulling both vantages in parallel — Hive's
  // fleet view and Pulse work-state:" — "now" leads, "pulling" was not in
  // the gerund list, hasActionableText was true, the loop idled.
  const nowGerundProgress = new RegExp(
    `^(?:now|next)[,:]?\\s+(?:${gerunds})\\b`,
    'i',
  );
  if (nowGerundProgress.test(normalized)) return true;

  // "Loading the skill and pulling the fleet snapshot in parallel:" — gerund
  // announcement that ends at a colon, no tool call.
  const colonGerund = new RegExp(`^(?:${gerunds})\\b.{0,240}:\\s*$`, 'i');
  if (colonGerund.test(normalized)) return true;

  // Kei 2026-09-11 gen34: "Snapshot is in hand — advancing PLAT-8469 now.
  // Opening the task, its comments, and available transitions in parallel:"
  // The gerund/colon rules only matched the START of the whole string, so a
  // one-line preamble hid a stalling last sentence and the heartbeat ended
  // as a completed answer (0 tools, ready queue, needs_help). Same rule as
  // the long-stall path: the ENDING is the signal.
  const sentences = normalized.split(/(?<=[.!?])\s+/).map((part) => part.trim()).filter(Boolean);
  const last = sentences[sentences.length - 1] ?? '';
  if (last && last !== normalized) {
    if (gerundProgress.test(last) || nowGerundProgress.test(last) || colonGerund.test(last)) {
      return true;
    }
  }

  return /^(?:searching|checking|inspecting|querying|fetching|pulling|loading|verifying|testing|debugging|investigating)\b[ .,!-]*$/i
    .test(normalized);
}
