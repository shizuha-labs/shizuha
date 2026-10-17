import type { Message } from './types.js';

/** Provenance is a separate typed field; never classify assistant prose by text. */
export function isFrameworkOperationalMessage(message: Message): boolean {
  const event = message.operationalEvent;
  return message.role === 'assistant' && event?.kind === 'framework_terminal_failure'
    && typeof event.id === 'string' && event.id.length > 0
    && (event.code === 'provider_failure' || event.code === 'context_capacity');
}

export function modelConversationMessages(messages: Message[]): Message[] {
  // Preserve the no-op compaction contract, including reference identity.
  return messages.some(isFrameworkOperationalMessage)
    ? messages.filter(message => !isFrameworkOperationalMessage(message))
    : messages;
}
