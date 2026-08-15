# X Tweet Pipeline — Systematic Architecture

## Problem Statement

Our first tweet attempt required 15+ throwaway scripts, multiple container restarts, account lockouts, and a password reset. The root cause: no reusable session management, no error recovery, and no persistent state.

## Design: Fast Tweet Pipeline

```
┌─────────────────────────────────────────────────────┐
│                  X Tweet Pipeline                     │
│                                                       │
│  ┌──────────┐   ┌──────────┐   ┌──────────────────┐ │
│  │  Session  │──→│  Login   │──→│  Compose & Post  │ │
│  │  Manager  │   │  Flow    │   │                  │ │
│  └──────────┘   └──────────┘   └──────────────────┘ │
│       │              │                    │           │
│       ▼              ▼                    ▼           │
│  ┌──────────┐   ┌──────────┐   ┌──────────────────┐ │
│  │ Persistent│   │  Error   │   │   Screenshot     │ │
│  │  Profile  │   │ Recovery │   │   Verification   │ │
│  └──────────┘   └──────────┘   └──────────────────┘ │
└─────────────────────────────────────────────────────┘
```

### Session Manager

**Responsibilities:**
- Maintain ONE persistent Chrome instance with ONE CDP connection
- Reuse Chrome profile across sessions (cookies, localStorage persist)
- Track login state (logged in / logged out / locked)
- Provide `BrowserAgent` instance for all interactions

**Key rules:**
- Never create more than 1 Chrome instance per host
- Never use a fresh profile if a persistent one exists
- If Chrome crashes, wait 30s before restarting (not instant)
- Store session cookies in `~/.shizuha/x-session/`

### Login Flow (with error recovery)

```
START
  │
  ├── Check: are we already logged in?
  │     └── GET x.com/home → check for [data-testid="tweetTextarea_0"]
  │           ├── YES → skip to Compose
  │           └── NO → continue to login
  │
  ├── Navigate to x.com/i/flow/login
  │     └── Wait for "Phone, email, or username" (max 20s)
  │
  ├── Type email → click Next
  │     └── Wait 5s for next step
  │
  ├── Check: what page appeared?
  │     ├── Password page → type password → click Log in → DONE
  │     ├── "Unusual activity" page → GO TO RECOVERY
  │     └── Error page → WAIT 1 HOUR, retry
  │
  └── RECOVERY: Password Reset
        ├── Navigate to x.com/i/flow/password_reset
        ├── Type email → Next
        ├── Select "Send email" → Next
        ├── WAIT FOR USER: email verification code
        ├── Enter code → Next
        ├── Set NEW password (must differ from current)
        ├── Select "I forgot my password" → Next
        ├── Click "Continue to X"
        └── DONE (logged in, lock cleared)
```

### Compose & Post

```
1. Verify: URL is x.com/home and compose area exists
2. Dismiss popups (close button, 2FA prompt)
3. Click [data-testid="tweetTextarea_0"]
4. Type tweet via Input.insertText (human-timed)
5. Verify: tweet text appears in compose area
6. Click [data-testid="tweetButtonInline"]
7. Wait 5s
8. Verify: tweet disappeared from compose (= posted)
9. Screenshot for confirmation
```

### Error Recovery Matrix

| Error | Detection | Recovery |
|-------|-----------|----------|
| "Unusual login activity" | Page text contains "unusual" | Password reset flow |
| "Something went wrong" | Page text contains "went wrong" | Wait 60s, reload |
| SIGILL crash | Chrome process exits | Restart Chrome, reload page |
| 429 rate limit | CDP Network response status=429 | Wait 15min |
| Arkose CAPTCHA | iframe.arkoselabs.com detected | Abort — need residential proxy |
| Session expired | Redirected to login from home | Re-login |
| Compose area missing | tweetTextarea_0 not found | Reload x.com/home |

### Timing Guidelines (human-like)

| Action | Minimum wait | Maximum wait |
|--------|-------------|-------------|
| After page navigation | 3s | 8s |
| Before typing | 200ms | 500ms |
| Between keystrokes | 40ms | 120ms |
| After typing, before clicking | 400ms | 800ms |
| After clicking a button | 3s | 8s |
| Between login attempts | 1 hour | 4 hours |
| After account lock detection | 6 hours | 24 hours |

### Persistent State

Store in `~/.shizuha/x-state.json`:
```json
{
  "lastLogin": "2026-03-23T02:00:00Z",
  "lastTweet": "2026-03-23T02:05:00Z",
  "loginAttempts": 1,
  "isLocked": false,
  "currentPassword": "(from ~/.shizuha/x-credentials.json)",
  "profileDir": "/home/stealth/x-session"
}
```

### Usage (target: single command)

```bash
# Post a tweet (handles login, recovery, posting, verification)
shizuha x tweet "Your tweet text here"

# Check account status
shizuha x status

# Login only (no tweet)
shizuha x login
```

## Implementation Priority

1. **BrowserAgent** (done): `src/input-devices/browser-agent.ts`
2. **X Session Manager**: persistent login state, Chrome lifecycle
3. **X Login Flow**: with automatic password-reset recovery
4. **X Tweet Command**: `shizuha x tweet "text"`
5. **Scheduled tweets**: cron-based posting via agent skills
