import type { CoreStreamEvent, DiffProposedPayload, StructuredCoreErrorPayload } from '../../../src/local-core-protocol.js';

export interface ToolBlock {
  id: string;
  kind: 'tool_call' | 'tool_result';
  name?: string;
  content?: unknown;
}

export interface DiffBlock {
  id: string;
  kind: 'diff_proposed';
  diff: DiffProposedPayload;
  /** Whether the user has acted on this diff. */
  action?: 'accepted' | 'rejected' | 'partial';
}

export interface ChatTurn {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  status?: string;
  tools?: ToolBlock[];
  diffs?: DiffBlock[];
  error?: StructuredCoreErrorPayload;
}

export interface ChatViewState {
  turns: ChatTurn[];
  runStatus: string;
  streaming: boolean;
  canRetry: boolean;
  /** Number of pending diffs awaiting user action. */
  pendingDiffCount: number;
}

export class ChatSessionState {
  private turns: ChatTurn[] = [];
  private activeAssistantId: string | null = null;
  private seq = 0;
  runStatus = 'idle';
  streaming = false;
  lastUserContent = '';

  snapshot(): ChatViewState {
    const last = this.turns[this.turns.length - 1];
    const pendingDiffCount = this.turns.reduce((count, turn) => {
      return count + (turn.diffs?.filter((d) => !d.action).length || 0);
    }, 0);
    return {
      turns: this.turns.map((turn) => ({
        ...turn,
        tools: turn.tools ? [...turn.tools] : [],
        diffs: turn.diffs ? turn.diffs.map((d) => ({ ...d })) : [],
      })),
      runStatus: this.runStatus,
      streaming: this.streaming,
      canRetry: !!last?.error?.retryable && !!this.lastUserContent,
      pendingDiffCount,
    };
  }

  beginUserMessage(content: string): ChatViewState {
    if (this.streaming) throw new Error('A Shizuha run is already in progress. Cancel it before sending another message.');
    const trimmed = content.trim();
    if (!trimmed) throw new Error('Message content is required.');
    this.lastUserContent = trimmed;
    this.turns.push({ id: this.nextId('user'), role: 'user', content: trimmed });
    const assistant = { id: this.nextId('assistant'), role: 'assistant' as const, content: '', status: 'running', tools: [] };
    this.turns.push(assistant);
    this.activeAssistantId = assistant.id;
    this.runStatus = 'running';
    this.streaming = true;
    return this.snapshot();
  }

  markSubmittingError(error: StructuredCoreErrorPayload): ChatViewState {
    this.assistant().error = error;
    this.assistant().status = 'error';
    this.runStatus = 'error';
    this.streaming = false;
    return this.snapshot();
  }

  markCancelling(): ChatViewState {
    if (this.streaming) this.runStatus = 'cancelling';
    return this.snapshot();
  }

  handleEvent(event: CoreStreamEvent, diffId?: string): ChatViewState {
    const turn = this.assistant();
    if (event.type === 'token') {
      turn.content += event.text;
      turn.status = 'running';
    } else if (event.type === 'tool_call' || event.type === 'tool_result') {
      turn.tools = turn.tools || [];
      turn.tools.push({ id: event.id, kind: event.type, name: event.name, content: event.content });
    } else if (event.type === 'diff_proposed') {
      turn.diffs = turn.diffs || [];
      // Use the authoritative ID from FileDiffHandler if provided, otherwise auto-generate.
      // This ensures the webview posts the same ID that FileDiffHandler.acceptDiff/rejectDiff expects.
      turn.diffs.push({ id: diffId || `diff-${turn.diffs.length + 1}`, kind: 'diff_proposed', diff: event.diff });
    } else if (event.type === 'run_status') {
      this.runStatus = event.status;
      turn.status = event.status;
      if (event.status === 'cancelled') {
        turn.content = turn.content || 'Run cancelled.';
        this.streaming = false;
      }
    } else if (event.type === 'error') {
      turn.error = event.error;
      turn.status = 'error';
      this.runStatus = 'error';
      this.streaming = false;
    } else if (event.type === 'done') {
      turn.status = 'done';
      this.runStatus = 'done';
      this.streaming = false;
    }
    return this.snapshot();
  }

  handleDiffAction(diffId: string, action: 'accepted' | 'rejected' | 'partial'): void {
    for (const turn of this.turns) {
      if (!turn.diffs) continue;
      for (const diff of turn.diffs) {
        if (diff.id === diffId) {
          diff.action = action;
          return;
        }
      }
    }
  }

  private nextId(prefix: string): string {
    this.seq += 1;
    return `${prefix}-${this.seq}`;
  }

  private assistant(): ChatTurn {
    const turn = this.turns.find((candidate) => candidate.id === this.activeAssistantId);
    if (!turn) {
      const assistant = { id: this.nextId('assistant'), role: 'assistant' as const, content: '', status: 'running', tools: [] };
      this.turns.push(assistant);
      this.activeAssistantId = assistant.id;
      return assistant;
    }
    return turn;
  }
}
