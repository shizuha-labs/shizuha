/**
 * better-sqlite3 in-memory stub for Android (nodejs-mobile).
 *
 * The native C++ SQLite addon can't run on nodejs-mobile. This provides
 * a functional in-memory implementation that handles the specific SQL
 * patterns used by StateStore and PermissionMemory.
 *
 * Data persists for the lifetime of the Node.js process (matching the
 * Android foreground service lifecycle). Cross-restart persistence
 * can be added later via sql.js (SQLite compiled to WASM).
 */

// Global in-memory store (shared across all Database instances)
const _sessions = new Map();     // id -> {id, model, cwd, created_at, updated_at, total_input_tokens, total_output_tokens, turn_count, name}
const _messages = [];            // [{id, session_id, role, content, timestamp}]
const _approvals = new Map();    // `tool\0pattern` -> {tool, pattern, decision, created_at}
const _checkpoints = new Map();  // session_id -> {created_at, prompt_excerpt, note}
const _toolApprovals = new Map(); // tool_name -> {tool_name, created_at}
let _nextMsgId = 1;

class Statement {
  constructor(sql) {
    this._sql = sql.trim().replace(/\s+/g, ' ');
  }

  run(...params) {
    const sql = this._sql;

    // INSERT INTO sessions
    if (sql.startsWith('INSERT INTO sessions')) {
      const [id, model, cwd, created_at, updated_at] = params;
      _sessions.set(id, {
        id, model, cwd, created_at, updated_at,
        total_input_tokens: 0, total_output_tokens: 0, turn_count: 0, name: null,
      });
      return { changes: 1, lastInsertRowid: 0 };
    }

    // INSERT INTO messages
    if (sql.startsWith('INSERT INTO messages')) {
      const [session_id, role, content, timestamp] = params;
      _messages.push({ id: _nextMsgId++, session_id, role, content, timestamp });
      return { changes: 1, lastInsertRowid: _nextMsgId - 1 };
    }

    // UPDATE sessions SET updated_at = ? WHERE id = ?
    if (sql.startsWith('UPDATE sessions SET updated_at')) {
      const session = _sessions.get(params[1]);
      if (session) session.updated_at = params[0];
      return { changes: session ? 1 : 0, lastInsertRowid: 0 };
    }

    // UPDATE sessions SET total_input_tokens = ...
    if (sql.includes('total_input_tokens = total_input_tokens +')) {
      const [inputTokens, outputTokens, updatedAt, id] = params;
      const session = _sessions.get(id);
      if (session) {
        session.total_input_tokens += inputTokens;
        session.total_output_tokens += outputTokens;
        session.turn_count += 1;
        session.updated_at = updatedAt;
      }
      return { changes: session ? 1 : 0, lastInsertRowid: 0 };
    }

    // UPDATE sessions SET name = ?, updated_at = ? WHERE id = ?
    if (sql.includes('SET name =')) {
      const [name, updatedAt, id] = params;
      const session = _sessions.get(id);
      if (session) { session.name = name; session.updated_at = updatedAt; }
      return { changes: session ? 1 : 0, lastInsertRowid: 0 };
    }

    // UPDATE sessions SET total_input_tokens = ?, total_output_tokens = ?, turn_count = ? WHERE id = ?
    if (sql.startsWith('UPDATE sessions SET total_input_tokens = ?')) {
      const [inputTokens, outputTokens, turnCount, id] = params;
      const session = _sessions.get(id);
      if (session) {
        session.total_input_tokens = inputTokens;
        session.total_output_tokens = outputTokens;
        session.turn_count = turnCount;
      }
      return { changes: session ? 1 : 0, lastInsertRowid: 0 };
    }

    // DELETE FROM messages WHERE session_id = ?
    if (sql.startsWith('DELETE FROM messages WHERE session_id')) {
      const sid = params[0];
      let removed = 0;
      for (let i = _messages.length - 1; i >= 0; i--) {
        if (_messages[i].session_id === sid) { _messages.splice(i, 1); removed++; }
      }
      return { changes: removed, lastInsertRowid: 0 };
    }

    // DELETE FROM sessions WHERE id = ?
    if (sql.startsWith('DELETE FROM sessions WHERE id')) {
      const deleted = _sessions.delete(params[0]);
      return { changes: deleted ? 1 : 0, lastInsertRowid: 0 };
    }

    // DELETE FROM session_interrupt_checkpoints WHERE session_id = ?
    if (sql.includes('session_interrupt_checkpoints')) {
      if (sql.startsWith('DELETE')) {
        const deleted = _checkpoints.delete(params[0]);
        return { changes: deleted ? 1 : 0, lastInsertRowid: 0 };
      }
      if (sql.startsWith('INSERT')) {
        const [session_id, created_at, prompt_excerpt, note] = params;
        _checkpoints.set(session_id, { created_at, prompt_excerpt, note });
        return { changes: 1, lastInsertRowid: 0 };
      }
    }

    // INSERT OR REPLACE INTO approvals
    if (sql.includes('INTO approvals')) {
      const [tool, pattern, decision] = params;
      _approvals.set(`${tool}\0${pattern ?? ''}`, { tool, pattern, decision, created_at: Date.now() });
      return { changes: 1, lastInsertRowid: 0 };
    }

    // INSERT OR IGNORE INTO tool_approvals
    if (sql.includes('INTO tool_approvals')) {
      const [tool_name, created_at] = params;
      if (!_toolApprovals.has(tool_name)) {
        _toolApprovals.set(tool_name, { tool_name, created_at });
      }
      return { changes: 1, lastInsertRowid: 0 };
    }

    // DELETE FROM tool_approvals WHERE tool_name = ?
    if (sql.includes('DELETE FROM tool_approvals')) {
      const deleted = _toolApprovals.delete(params[0]);
      return { changes: deleted ? 1 : 0, lastInsertRowid: 0 };
    }

    return { changes: 0, lastInsertRowid: 0 };
  }

  get(...params) {
    const sql = this._sql;

    // SELECT * FROM sessions WHERE id = ?
    if (sql.includes('FROM sessions WHERE id')) {
      return _sessions.get(params[0]);
    }

    // SELECT decision FROM approvals WHERE tool = ?
    if (sql.includes('FROM approvals WHERE tool')) {
      const tool = params[0];
      // Find any approval for this tool
      for (const [key, val] of _approvals) {
        if (val.tool === tool) return val;
      }
      return undefined;
    }

    // SELECT ... FROM session_interrupt_checkpoints WHERE session_id = ?
    if (sql.includes('session_interrupt_checkpoints WHERE session_id')) {
      return _checkpoints.get(params[0]);
    }

    return undefined;
  }

  all(...params) {
    const sql = this._sql;

    // SELECT role, content, timestamp FROM messages WHERE session_id = ? ORDER BY id
    if (sql.includes('FROM messages WHERE session_id')) {
      const sid = params[0];
      return _messages
        .filter(m => m.session_id === sid)
        .sort((a, b) => a.id - b.id)
        .map(({ role, content, timestamp }) => ({ role, content, timestamp }));
    }

    // SELECT tool_name FROM tool_approvals
    if (sql.includes('FROM tool_approvals')) {
      return Array.from(_toolApprovals.values());
    }

    // SELECT ... FROM sessions ... (list sessions)
    if (sql.includes('FROM sessions')) {
      const limit = params[params.length - 1] || 20;
      return Array.from(_sessions.values())
        .sort((a, b) => b.updated_at - a.updated_at)
        .slice(0, limit)
        .map(s => ({
          ...s,
          first_message: _messages.find(m => m.session_id === s.id && m.role === 'user')?.content?.slice(0, 80) ?? null,
        }));
    }

    return [];
  }
}

class Database {
  constructor(_filename, _options) {}

  pragma(_str) {
    // table_info query — return empty (triggers migration which is a no-op)
    return [];
  }

  exec(_sql) {
    // DDL statements — no-op (tables are implicit in our Maps)
    return this;
  }

  prepare(sql) {
    return new Statement(sql);
  }

  transaction(fn) {
    // Just call the function directly (no real transaction needed for in-memory)
    return (...args) => fn(...args);
  }

  close() {}
}

export default Database;
