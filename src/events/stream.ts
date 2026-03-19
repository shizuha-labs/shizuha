import type { AgentEvent } from './types.js';

/** Serialize an AgentEvent to NDJSON (one JSON line) */
export function toNDJSON(event: AgentEvent): string {
  return JSON.stringify(event) + '\n';
}

/** Serialize an AgentEvent to SSE format */
export function toSSE(event: AgentEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

/** Parse an NDJSON line back to an AgentEvent */
export function fromNDJSON(line: string): AgentEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as AgentEvent;
  } catch {
    return null;
  }
}
