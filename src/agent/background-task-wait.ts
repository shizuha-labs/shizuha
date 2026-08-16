import type { Message } from './types.js';
import type { BackgroundTaskRegistry } from '../tasks/registry.js';
import { strippedVisibleTextFromContent } from './content.js';

/** Bash background commands are capped at 600s; allow ten seconds to surface their terminal event. */
export const MAX_BACKGROUND_TASK_WAIT_MS = 610_000;
const DEFAULT_BACKGROUND_TASK_WAIT_MS = MAX_BACKGROUND_TASK_WAIT_MS;

export const BACKGROUND_TASK_WAIT_EXPIRED_MESSAGE =
  '[System] The bounded automatic wait for background tasks expired. Inspect the task now with TaskOutput, stop it with TaskStop, or finish with the evidence already available. Do not reply with another wait-only message; a repeated wait will end this agent run. Background tasks retain their normal caller-specific lifecycle.';

export type BackgroundTaskWaitAction = 'terminate' | 'continue' | 'nudge';

/**
 * True only for a short response whose action is to wait for asynchronous work.
 * Ordinary final answers — including ones that leave a server running — must
 * remain terminal and never inherit background-task latency.
 */
export function isBackgroundTaskWaitIntent(text: string): boolean {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized || normalized.length > 700) return false;

  const humanGate = /\b(?:wait|await|waiting|awaiting)\b\s+(?:for\s+)?(?:your|the user(?:'s)?|user|operator|human|approval|permission|confirmation|instructions?)\b/i;
  const commandGate = /\b(?:wait|await|waiting|awaiting)\b\s+for\s+(?:your\s+)?command\s+(?:before|to)\b/i;
  const negatedWait = /\b(?:(?:i\s+)?(?:won't|will not|wouldn't|do not|don't|cannot|can't)\s+(?:just\s+)?(?:wait|await)|(?:no need to|without|rather than)\s+(?:wait|await|waiting|awaiting))\b/i;
  const assignmentGate = /\b(?:wait|await|waiting|awaiting)\b\s+for\s+(?:the\s+)?task\s+(?:assignment|from\s+(?:you|the user|user|operator|a human))\b/i;
  const completedWait = /\b(?:was|were|finished|done|after|stopped)\s+(?:already\s+)?(?:wait|waiting|await|awaiting)\b/i;
  if (humanGate.test(normalized)
    || commandGate.test(normalized)
    || assignmentGate.test(normalized)
    || negatedWait.test(normalized)
    || completedWait.test(normalized)) {
    return false;
  }

  const qualifier = '(?:(?:the|this|that|a|an|first|second|current|running)\\s+)*';
  const resultTarget = `(?:${qualifier}background\\s+(?:task|command|process)|${qualifier}task\\s+(?:results?|output)|${qualifier}test(?:s|\\s+suite)?(?:\\s+results?)?|${qualifier}(?:test\\s+)?results?|${qualifier}(?:command|task|test)\\s+output|${qualifier}suite)`;
  const activeTarget = `(?:${qualifier}tests?|${qualifier}test\\s+suite|${qualifier}command|${qualifier}process|${qualifier}benchmark\\s+run|${qualifier}background\\s+(?:task|command|process))`;
  const waitVerb = '(?:wait|await|waiting|awaiting)';
  const waitForResult = new RegExp(`\\b${waitVerb}\\b\\s+(?:(?:for|on)\\s+)?${resultTarget}\\b`, 'i');
  const waitForPronoun = /\b(?:wait|await|waiting|awaiting)\b\s+for\s+it\s+to\s+(?:finish|complete)\b/i;
  const waitUntilFinished = new RegExp(`\\b${waitVerb}\\b\\s+until\\s+${activeTarget}\\s+(?:finish(?:es)?|complete(?:s)?)\\b`, 'i');
  const activeThenWait = new RegExp(
    `\\b${activeTarget}\\b\\s+(?:is|are)\\s+(?:still\\s+)?running\\b.{0,80}\\b(?:i(?:'|\\u2019)?ll wait|i will wait|waiting|awaiting)\\b`,
    'i',
  );
  return waitForResult.test(normalized)
    || waitForPronoun.test(normalized)
    || waitUntilFinished.test(normalized)
    || activeThenWait.test(normalized);
}

export function isBackgroundTaskWaitContentIntent(content: Message['content']): boolean {
  return isBackgroundTaskWaitIntent(strippedVisibleTextFromContent(content));
}

function configuredWaitBudgetMs(raw = process.env['SHIZUHA_BACKGROUND_TASK_WAIT_MS']): number {
  if (raw == null || raw.trim() === '') return DEFAULT_BACKGROUND_TASK_WAIT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_BACKGROUND_TASK_WAIT_MS;
  return Math.min(Math.floor(parsed), MAX_BACKGROUND_TASK_WAIT_MS);
}

/**
 * One controller per agent run. Its deadline is absolute from the first
 * wait-only turn, so a model cannot create an infinite chain of fresh waits.
 */
export class BackgroundTaskWaitController {
  private readonly budgetMs: number;
  private readonly abort = new AbortController();
  private deadlineAt: number | null = null;
  private expiryNudgeSent = false;
  private disposed = false;
  private externalSignal?: AbortSignal;
  private externalAbort?: () => void;

  constructor(budgetMs = configuredWaitBudgetMs(), externalSignal?: AbortSignal) {
    this.budgetMs = Math.min(Math.max(0, Math.floor(budgetMs)), MAX_BACKGROUND_TASK_WAIT_MS);
    if (externalSignal) {
      this.externalSignal = externalSignal;
      this.externalAbort = () => this.dispose();
      if (externalSignal.aborted) this.dispose();
      else externalSignal.addEventListener('abort', this.externalAbort, { once: true });
    }
  }

  async decide(text: string, registry: BackgroundTaskRegistry): Promise<BackgroundTaskWaitAction> {
    if (this.disposed) return 'terminate';
    if (!isBackgroundTaskWaitIntent(text)) return 'terminate';

    // The task can finish while the model is generating its wait-only turn.
    // Check unreported terminal state before runningCount or the result is lost
    // precisely in that common race.
    const alreadyTerminal = registry.nextUnreportedTerminal();
    if (alreadyTerminal) return 'continue';
    if (registry.runningCount === 0) return 'terminate';

    if (this.expiryNudgeSent) {
      return 'terminate';
    }

    if (this.deadlineAt == null) this.deadlineAt = Date.now() + this.budgetMs;
    const remainingMs = Math.max(0, this.deadlineAt - Date.now());
    const terminal = await registry.waitForNextTerminal(remainingMs, this.abort.signal);
    if (terminal) return 'continue';
    if (this.disposed) return 'terminate';

    this.expiryNudgeSent = true;
    return 'nudge';
  }

  nudgeMessage(): Message {
    return {
      role: 'user',
      content: BACKGROUND_TASK_WAIT_EXPIRED_MESSAGE,
      timestamp: Date.now(),
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.externalSignal && this.externalAbort) {
      this.externalSignal.removeEventListener('abort', this.externalAbort);
    }
    this.abort.abort();
  }
}

/**
 * Shared integration boundary for every compatible agent loop. It accepts the
 * raw assistant content so both callers use the same visible-text stripping,
 * and refuses to classify turns that actually issued tools.
 */
export async function decideBackgroundTaskContinuation(options: {
  controller: BackgroundTaskWaitController;
  registry: BackgroundTaskRegistry;
  toolCallCount: number;
  assistantContent: Message['content'];
}): Promise<BackgroundTaskWaitAction> {
  if (options.toolCallCount !== 0) return 'terminate';
  return options.controller.decide(strippedVisibleTextFromContent(options.assistantContent), options.registry);
}
