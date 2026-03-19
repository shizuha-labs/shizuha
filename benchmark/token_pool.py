"""Thread-safe Claude OAuth token pool with LRU round-robin and exhaustion tracking.

Mirrors the TypeScript ClaudeAccountPool pattern from shizuha's provider/claude-code.ts:
- Per-token exhaustedUntil tracking
- Least-recently-used selection for even load distribution
- Reset time parsing from Claude CLI output
- Stall-and-wait when all tokens exhausted (up to 10 min)
"""

import json
import re
import sys
import threading
import time
from datetime import datetime, timezone


class ClaudeTokenPool:
    """Manages Claude OAuth tokens with load balancing and exhaustion tracking."""

    def __init__(self, accounts: list[dict]):
        self._lock = threading.Lock()
        self._tokens: list[dict] = []
        for i, acct in enumerate(accounts):
            token = acct.get("token", "")
            if not token:
                continue
            self._tokens.append({
                "label": acct.get("label", f"token_{i + 1}"),
                "token": token,
                "exhausted_until": None,  # epoch timestamp (seconds) when usable again
                "last_used": 0.0,         # monotonic time of last acquire
            })

    def __len__(self) -> int:
        return len(self._tokens)

    @classmethod
    def from_config(cls) -> "ClaudeTokenPool":
        """Create pool from CLAUDE_ACCOUNTS_JSON in config module."""
        try:
            from config import CLAUDE_ACCOUNTS_JSON
            accounts = json.loads(CLAUDE_ACCOUNTS_JSON)
            return cls(accounts if accounts else [])
        except Exception:
            return cls([])

    def acquire(self, max_wait: float = 600.0) -> tuple[str, str] | None:
        """Get next available (label, token) using LRU round-robin.

        Picks the token with the oldest last_used timestamp among non-exhausted
        tokens. If all tokens are exhausted, waits for the earliest reset
        (up to max_wait seconds).

        Returns:
            (label, token) tuple, or None if all exhausted beyond max_wait.
        """
        deadline = time.monotonic() + max_wait

        while True:
            with self._lock:
                now_epoch = time.time()
                now_mono = time.monotonic()

                # Find available tokens (not exhausted, or exhaustion expired)
                available = []
                for entry in self._tokens:
                    if entry["exhausted_until"] is None or entry["exhausted_until"] <= now_epoch:
                        entry["exhausted_until"] = None  # clear expired exhaustion
                        available.append(entry)

                if available:
                    # LRU: pick token with oldest last_used
                    best = min(available, key=lambda e: e["last_used"])
                    best["last_used"] = now_mono
                    return best["label"], best["token"]

                # All exhausted — find earliest reset
                earliest = min(
                    (e["exhausted_until"] for e in self._tokens if e["exhausted_until"] is not None),
                    default=None,
                )

            if earliest is None:
                return None  # no tokens at all

            wait_secs = earliest - time.time()
            if wait_secs <= 0:
                continue  # already expired, re-check

            if time.monotonic() + wait_secs > deadline:
                # Would exceed max wait
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    print(f"  [pool] all tokens exhausted, max wait ({max_wait:.0f}s) exceeded", file=sys.stderr)
                    return None
                wait_secs = remaining

            labels = ", ".join(e["label"] for e in self._tokens)
            print(
                f"  [pool] all tokens exhausted ({labels}), "
                f"waiting {wait_secs:.0f}s for earliest reset...",
                file=sys.stderr,
            )
            time.sleep(min(wait_secs + 1, 30))  # sleep in chunks, re-check

    def release(
        self,
        token: str,
        success: bool,
        rate_limited: bool = False,
        usage_limited: bool = False,
        reset_at: float | None = None,
    ) -> None:
        """Report token usage result.

        Args:
            token: The token string that was used.
            success: Whether the call succeeded.
            rate_limited: Short-term rate limit (seconds cooldown).
            usage_limited: Long-term usage limit (hours cooldown).
            reset_at: Epoch timestamp when the token becomes usable again.
                      If None and limited, defaults to 60s (rate) or 3600s (usage).
        """
        with self._lock:
            for entry in self._tokens:
                if entry["token"] != token:
                    continue

                if success:
                    entry["exhausted_until"] = None
                    return

                if usage_limited or rate_limited:
                    if reset_at is not None:
                        entry["exhausted_until"] = reset_at
                    elif usage_limited:
                        entry["exhausted_until"] = time.time() + 3600  # 1 hour default
                    else:
                        entry["exhausted_until"] = time.time() + 60  # 1 min default for rate limit
                    label = entry["label"]
                    until = entry["exhausted_until"]
                    wait = until - time.time()
                    kind = "usage-limited" if usage_limited else "rate-limited"
                    print(
                        f"  [pool] {label} {kind}, cooldown {wait:.0f}s",
                        file=sys.stderr,
                    )
                return

    @staticmethod
    def parse_reset_time(output: str) -> float | None:
        """Parse Claude CLI output for reset time.

        Patterns matched (mirrors TypeScript parseRateLimitResetWait):
        - "try again in X seconds"
        - "resets at Xpm (UTC)" / "resets Xpm (UTC)"
        - "try again after X:XX PM"
        - "Your limit will reset at X:XX PM UTC"

        Returns:
            Epoch timestamp (seconds) when the limit resets, or None.
        """
        if not output:
            return None

        # Pattern 1: "try again in X seconds"
        m = re.search(r'try again in (\d+)\s*seconds?', output, re.IGNORECASE)
        if m:
            return time.time() + int(m.group(1))

        # Pattern 2: "resets Xam/pm (UTC)" or "resets at Xam/pm (UTC)"
        m = re.search(r'resets\s+(?:at\s+)?(\d{1,2})(am|pm)\s*\(UTC\)', output, re.IGNORECASE)
        if m:
            hour = int(m.group(1))
            ampm = m.group(2).lower()
            if ampm == 'pm' and hour < 12:
                hour += 12
            if ampm == 'am' and hour == 12:
                hour = 0
            now = datetime.now(timezone.utc)
            reset = now.replace(hour=hour, minute=0, second=0, microsecond=0)
            if reset <= now:
                reset = reset.replace(day=reset.day + 1)
            return reset.timestamp()

        # Pattern 3: "try again after X:XX PM" or "reset at X:XX PM UTC"
        m = re.search(
            r'(?:try again after|reset(?:s)?\s+at)\s+(\d{1,2}):(\d{2})\s*(AM|PM)(?:\s*UTC)?',
            output, re.IGNORECASE,
        )
        if m:
            hour = int(m.group(1))
            minute = int(m.group(2))
            ampm = m.group(3).lower()
            if ampm == 'pm' and hour < 12:
                hour += 12
            if ampm == 'am' and hour == 12:
                hour = 0
            now = datetime.now(timezone.utc)
            reset = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
            if reset <= now:
                reset = reset.replace(day=reset.day + 1)
            return reset.timestamp()

        return None


# Singleton pool instance (lazy-initialized, thread-safe)
_pool: ClaudeTokenPool | None = None
_pool_lock = threading.Lock()


def get_token_pool() -> ClaudeTokenPool:
    """Get or create the shared singleton token pool."""
    global _pool
    if _pool is None:
        with _pool_lock:
            if _pool is None:
                _pool = ClaudeTokenPool.from_config()
                print(f"  [pool] initialized with {len(_pool)} token(s)", file=sys.stderr)
    return _pool
