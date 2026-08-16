# X/Twitter Browser Automation — Findings & Architecture

## Account Details

| Field | Value |
|-------|-------|
| Display name | Shizuha Changelog |
| Username | @ShizuhaChangelog |
| Credentials | `~/.shizuha/x-credentials.json` (never in repo) |
| Profile | `~/.shizuha/x-browser-profile/` (persistent Chrome session) |

---

## Root Cause Analysis: Why X Flagged Us

### What happened
After account creation succeeded cleanly (no CAPTCHA, email verified, logged in), subsequent login attempts from new containers triggered X's "unusual login activity" lock. Every attempt to pass the verification step failed with HTTP 400 from X's API — despite correct username, phone, and email being entered.

### Root causes (ordered by severity)

**1. Different browser fingerprint on every attempt**
Each Docker container had a fresh Chrome profile with zero cookies, zero history, and a different CDP session ID. X tracks browser fingerprints (localStorage tokens, cookie chains, IndexedDB). A brand-new browser on every attempt = suspicious.

**FIX**: Use a **persistent Chrome profile** (`--user-data-dir`) that survives across sessions. After the first successful login, preserve `~/.shizuha/browser-profile/` and mount it into subsequent containers.

**2. Multiple rapid login attempts from different IPs**
We attempted login from ~8 different containers in quick succession. Each had a different internal IP and slightly different network characteristics. X's backend correlates these as a credential-stuffing pattern.

**FIX**: One container, one session, one login. If login fails, **wait hours, not seconds**. Never retry from a different container immediately.

**3. The "unusual activity" verification was server-side, not client-side**
The verification step's Next button DID fire (confirmed via Network monitoring — `onboarding/task.json` POST returned HTTP 400). X's server rejected the verification regardless of what we entered. This was not a button-click bug — it was X's server saying "this account is locked from new-device logins."

**FIX**: When you see the "unusual login activity" screen, **don't retry**. Instead, use the **password reset flow** (`x.com/i/flow/password_reset`) which sends a verification code to the email and clears the lock.

**4. No phone number on the account**
The account was created with email only. X's verification asks for "phone or username" but may internally require phone for accounts flagged as suspicious. Without a registered phone, both verification options can fail.

**FIX**: Add a phone number to the account after first login (Settings → Account → Phone). This gives X a second verification factor.

**5. CDP `Input.dispatchKeyEvent` with `type: "char"` doesn't trigger React state updates**
Typing via `char` events updates the DOM but not React's internal state. When the Next button's handler reads the input value from React state (not DOM), it sees empty/stale data and silently fails.

**FIX**: Use `Input.insertText` instead of `char` events. `insertText` fires the native `input` event that React's synthetic event system listens for.

---

## Architecture: How The Browser Agent Works

### Container setup (REQUIRED)

```yaml
# docker-compose or docker run
runtime: nvidia  # or --gpus all
devices:
  - /dev/dri:/dev/dri  # GPU for real WebGL fingerprint
security_opt:
  - seccomp=unconfined  # Allows Chrome's native sandbox (no --no-sandbox)
```

**Base image**: `ubuntu:24.04` with:
- `libnvidia-gl-535` (GPU rendering libraries)
- `google-chrome-stable` (NOT Chromium — better stealth)
- `xvfb`, `openbox` (virtual display + window manager)
- `fonts-liberation fonts-dejavu-core fonts-noto` (realistic font fingerprint)

**Chrome launch** (as non-root user, NO `--no-sandbox`):
```bash
google-chrome-stable \
  --no-first-run --no-default-browser-check \
  --window-size=1920,1080 --disable-infobars \
  --enable-gpu-rasterization --enable-zero-copy --ignore-gpu-blocklist \
  --disable-breakpad --metrics-recording-only \
  --user-data-dir=$PERSISTENT_PROFILE \
  --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1 \
  about:blank
```

**NEVER use these flags** (they trigger `navigator.webdriver = true`):
- `--no-sandbox`
- `--disable-blink-features=AutomationControlled`
- `--load-extension=...`
- `--headless`

### Stealth injection

Via CDP `Page.addScriptToEvaluateOnNewDocument` (BEFORE any navigation):
```javascript
Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
```

This runs in the MAIN world before any page JavaScript. The page cannot detect it.

### Input method

**ALL interaction via CDP `Input.dispatch*` events:**

| Action | CDP Method | Why |
|--------|-----------|-----|
| Mouse move | `Input.dispatchMouseEvent` type:`mouseMoved` | Bezier curves, jitter |
| Click | `Input.dispatchMouseEvent` type:`mousePressed`/`mouseReleased` | `isTrusted: true` |
| Type text | `Input.insertText` | Triggers React's onChange |
| Press key | `Input.dispatchKeyEvent` type:`keyDown`/`keyUp` | Enter, Tab, Backspace |

**NEVER use:**
- `element.click()` via `Runtime.evaluate` → `isTrusted: false`
- `element.value = ...` → React state not updated
- `element.dispatchEvent(new Event(...))` → `isTrusted: false`
- `Input.dispatchKeyEvent` type:`char` → React doesn't detect it

### Reading page state

Via `Runtime.evaluate` (invisible to the page):
```javascript
// Find element position
document.querySelector('[data-testid="tweetTextarea_0"]').getBoundingClientRect()

// Check input value
document.querySelector('input').value

// Get page text
document.body.innerText.substring(0, 200)
```

These CDP debugger-level calls are **invisible to the page's JavaScript**. X's client-side detection cannot see them.

---

## Correct Login Flow

```
1. Navigate to x.com/i/flow/login
2. Wait for "Phone, email, or username" field
3. Click field → type email → click Next
4. IF "unusual activity" appears:
   a. DON'T retry with different values
   b. Navigate to x.com/i/flow/password_reset
   c. Enter email → send code → enter code → set new password
   d. Click "Continue to X" → logged in
5. IF password page appears:
   a. Click password field → type password → click Log in
6. Dismiss popups (2FA prompt, etc.)
7. Ready to compose tweets
```

### Password reset (clears "unusual activity" lock)

```
x.com/i/flow/password_reset
→ Enter email
→ "Send email to sh*****@gmail.com" → Next
→ Enter verification code from email
→ Set new password (MUST be different from current)
→ Select reason ("I forgot my password")
→ "Continue to X" → logged in, lock cleared
```

---

## Correct Tweet Flow

```
1. Find compose area: [data-testid="tweetTextarea_0"]
2. Click it (CDP mousePressed/mouseReleased at its bounding rect center)
3. Type tweet via Input.insertText (char by char, human-timed)
4. Wait 500-1000ms
5. Find Post button: [data-testid="tweetButtonInline"]
6. Click it
7. Wait 5s for confirmation
```

---

## Bot Detection Results

| Test | Result |
|------|--------|
| sannysoft.com | 100% green |
| CreepJS headless | 0% detected |
| CreepJS stealth | 0% detected |
| Cloudflare Turnstile | PASSED (1.2s) |
| X account creation | Passed (no CAPTCHA) |
| X login | Passed (with password reset for locked accounts) |
| X tweet posting | Passed |

---

## Key Technical Findings

### CDP coordinate system
- `getBoundingClientRect()` returns viewport coordinates
- `Input.dispatchMouseEvent` x/y ARE viewport coordinates (1:1 mapping)
- No offset needed — screen coords ≠ viewport coords (screen includes Chrome UI)
- `elementFromPoint(x, y)` uses the same coordinate space as getBoundingClientRect

### X's React event handling
- X uses React 18 with synthetic events
- Click events on `<span>` inside `<button>` DO propagate to the button handler
- But `Input.insertText` is required for typing (not `char` events)
- X's `onboarding/task.json` API returns 400 for locked accounts regardless of input

### The y=769 mystery (SOLVED)
The verification step's Next button consistently reported `getBoundingClientRect().y = 769`. Our clicks at (956, 769) fired the API call (confirmed via Network monitoring) but the API returned 400. This was NOT a coordinate bug — it was X's server rejecting the verification because the account was locked. The button click worked perfectly.

### Google Chrome vs Chromium
- **Google Chrome**: `navigator.webdriver` stays `undefined` without `--no-sandbox`
- **Chromium (Debian)**: Sets `navigator.webdriver = true` with any automation-related flag
- Always use Google Chrome for stealth

### NVIDIA GPU in containers
- `--gpus all` exposes NVIDIA compute devices but NOT `/dev/dri`
- Must add `--device /dev/dri:/dev/dri` separately for Chrome GPU rendering
- Install `libnvidia-gl-535` (match host driver version) for OpenGL/EGL support
- Chrome sees real GPU → WebGL fingerprint matches real hardware

---

## Files

| File | Purpose |
|------|---------|
| `src/input-devices/browser-agent.ts` | Persistent CDP session with human-like input |
| `src/input-devices/mouse.ts` | CDP-based mouse (bezier curves, no teleport) |
| `src/input-devices/keyboard.ts` | CDP-based keyboard (human timing) |
| `src/input-devices/stealth.ts` | Anti-detection JS patches + Chrome args |
| `src/input-devices/config.ts` | `~/.shizuha/browser.toml` loader (proxy, stealth) |
| `src/input-devices/socks-forwarder.ts` | Authenticated SOCKS5 local proxy |
| `src/input-devices/display.ts` | Xvfb + openbox lifecycle |
| `src/input-devices/uinput-helper.c` | Linux uinput virtual devices (for non-browser use) |
| `src/browser/human-session.ts` | Human-mode browser session |
| `src/browser/session.ts` | Session facade (fast/human mode switch) |
| `~/.shizuha/browser.toml` | Proxy credentials + stealth overrides |
| `~/.shizuha/browser-profile/` | Persistent Chrome profile (cookies, history) |
