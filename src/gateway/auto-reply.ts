/**
 * Auto-Reply Engine — intercepts inbound messages before they reach the LLM.
 *
 * Supports pattern-based automatic responses for consumer bots:
 * greetings, FAQ, away messages, etc. Rules are loaded from config
 * (shizuha.toml `[autoReply]` section).
 *
 * Pattern types:
 *   - Exact string: "hello" matches "hello" only
 *   - Glob wildcard: "hello *" matches "hello world", "hello there"
 *   - Regex: "/^(hi|hey|hello)$/i" matches common greetings
 *
 * Response template variables: {user}, {channel}, {time}
 */

import type { InboundMessage } from './types.js';
import type { ChannelType } from './types.js';
import { logger } from '../utils/logger.js';

export interface AutoReplyRule {
  /** Pattern to match: exact string, glob with *, or regex wrapped in /pattern/flags */
  pattern: string;
  /** Response text (supports {user}, {channel}, {time} templates) */
  response: string;
  /** Optional channel type filter — only match on these channel types */
  channels?: string[];
  /** Case-sensitive matching (default: false) */
  caseSensitive: boolean;
  /** Priority — higher values are checked first (default: 0) */
  priority: number;
}

/** Compiled rule with pre-built matcher for fast checking. */
interface CompiledRule {
  rule: AutoReplyRule;
  matcher: (text: string) => boolean;
}

export class AutoReplyEngine {
  private rules: CompiledRule[] = [];

  constructor(rules: AutoReplyRule[]) {
    // Sort by priority descending (higher = checked first), then by original order
    const sorted = [...rules].sort((a, b) => b.priority - a.priority);
    this.rules = sorted.map((rule) => ({
      rule,
      matcher: compileMatcher(rule.pattern, rule.caseSensitive),
    }));
    if (this.rules.length > 0) {
      logger.info({ ruleCount: this.rules.length }, 'Auto-reply engine initialized');
    }
  }

  /**
   * Check if an inbound message matches any auto-reply rule.
   * Returns the response string if matched, null if no match.
   */
  check(msg: InboundMessage): string | null {
    // Only match on string content
    if (typeof msg.content !== 'string') return null;
    const text = msg.content.trim();
    if (!text) return null;

    for (const { rule, matcher } of this.rules) {
      // Channel filter
      if (rule.channels && rule.channels.length > 0) {
        if (!rule.channels.includes(msg.channelType)) continue;
      }

      if (matcher(text)) {
        const response = expandTemplates(rule.response, msg);
        logger.debug(
          { pattern: rule.pattern, channelType: msg.channelType, userId: msg.userId },
          'Auto-reply matched',
        );
        return response;
      }
    }

    return null;
  }
}

// ── Pattern compilation ──

function compileMatcher(pattern: string, caseSensitive: boolean): (text: string) => boolean {
  // Regex pattern: /pattern/flags
  const regexMatch = pattern.match(/^\/(.+)\/([gimsuy]*)$/);
  if (regexMatch) {
    const [, body, flags] = regexMatch;
    try {
      // Add 'i' flag if not case sensitive and 'i' not already present
      let finalFlags = flags!;
      if (!caseSensitive && !finalFlags.includes('i')) {
        finalFlags += 'i';
      }
      const regex = new RegExp(body!, finalFlags);
      return (text: string) => regex.test(text);
    } catch (err) {
      logger.warn({ pattern, err }, 'Invalid regex in auto-reply rule, treating as literal');
      // Fall through to literal matching
    }
  }

  // Glob pattern (contains *)
  if (pattern.includes('*')) {
    const regexStr = pattern
      .split('*')
      .map(escapeRegex)
      .join('.*');
    const flags = caseSensitive ? '' : 'i';
    const regex = new RegExp(`^${regexStr}$`, flags);
    return (text: string) => regex.test(text);
  }

  // Exact string match
  if (caseSensitive) {
    return (text: string) => text === pattern;
  }
  const lower = pattern.toLowerCase();
  return (text: string) => text.toLowerCase() === lower;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── Template expansion ──

function expandTemplates(response: string, msg: InboundMessage): string {
  const now = new Date();
  return response
    .replace(/\{user\}/g, msg.userName ?? msg.userId ?? 'there')
    .replace(/\{channel\}/g, msg.channelType)
    .replace(/\{time\}/g, now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }));
}
