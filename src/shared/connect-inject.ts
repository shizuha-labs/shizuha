/**
 * Connect inject-once policy (all harnesses).
 *
 * A Connect DM / group message is **one user turn injected into the agent**.
 * Same mental model as human chat:
 *   - Bridge delivers the message into history / the next model turn.
 *   - Whether the agent calls message_user (or any tool) is agent choice.
 *   - Silence is valid. Silence must never:
 *       • re-queue / clean-thread-replay the same DM
 *       • count toward empty-turn / provider-unavailable exhaustion
 *       • stick a provider-unavailable marker or exit-code backoff
 *
 * The only legitimate re-inject is a **transient transport failure** before a
 * completed model turn (network blip). Completed turns always ack/consume.
 *
 * Harnesses: codex-bridge, claude-bridge, antigravity-bridge, openclaw-bridge,
 * gateway ConnectChannel. Keep this contract aligned across them.
 */

export function isConnectClientId(clientId: string | null | undefined): boolean {
  return Boolean(clientId?.startsWith('connect:'));
}

/**
 * Whether a completed turn with no tool/text output should escalate the
 * empty-turn / provider-unavailable path.
 *
 * Returns false when:
 * - the turn was a Connect inject (silence is agent choice)
 * - the model produced any event (reasoning, streaming, tools) — not a silent provider swallow
 * - the content is a silent system task-update style notice
 */
export function shouldEscalateEmptyTurnAsProviderFailure(opts: {
  isConnectInject: boolean;
  modelProducedEvents: boolean;
  isSilentSystemUpdate: boolean;
}): boolean {
  if (opts.isConnectInject) return false;
  if (opts.isSilentSystemUpdate) return false;
  if (opts.modelProducedEvents) return false;
  return true;
}
