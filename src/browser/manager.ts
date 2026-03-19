import { BrowserSession } from './session.js';

const MAX_CONCURRENT_SESSIONS = 3;

class BrowserManager {
  private sessions = new Map<string, BrowserSession>();

  /** Get or create a browser session for the given session ID */
  getSession(sessionId: string): BrowserSession {
    let session = this.sessions.get(sessionId);
    if (session) return session;

    if (this.sessions.size >= MAX_CONCURRENT_SESSIONS) {
      throw new Error(
        `Maximum concurrent browser sessions (${MAX_CONCURRENT_SESSIONS}) reached. ` +
        'Close an existing session first with the "close" action.',
      );
    }

    session = new BrowserSession(() => {
      // Auto-remove from map when session closes (idle timeout or explicit close)
      this.sessions.delete(sessionId);
    });
    this.sessions.set(sessionId, session);
    return session;
  }

  /** Close all active sessions (call on process exit) */
  async closeAll(): Promise<void> {
    const closeTasks = [...this.sessions.values()].map((s) => s.close());
    await Promise.allSettled(closeTasks);
    this.sessions.clear();
  }

  get activeCount(): number {
    return this.sessions.size;
  }
}

/** Singleton browser manager */
export const browserManager = new BrowserManager();

// Cleanup on process exit
const cleanup = (): void => {
  void browserManager.closeAll();
};
process.on('exit', cleanup);
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
