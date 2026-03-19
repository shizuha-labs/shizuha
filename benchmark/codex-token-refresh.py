#!/usr/bin/env python3
"""Codex OAuth token refresh daemon.

Keeps all Codex account tokens in ~/.codex/accounts/ fresh by periodically
refreshing them before they expire. Runs as a systemd user service.

Token lifecycle:
  - Access tokens expire after ~10 days (240h)
  - Refresh tokens are SINGLE-USE: once used, a new refresh_token is issued
  - This daemon refreshes when <48h remaining on the access_token
  - Checks every 2 hours

Usage:
  python3 codex-token-refresh.py           # Run once (check + refresh)
  python3 codex-token-refresh.py --daemon  # Run forever (check every 2h)
  python3 codex-token-refresh.py --status  # Show token status
"""

import argparse
import base64
import json
import logging
import os
import shutil
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ACCOUNTS_DIR = Path(os.path.expanduser("~/.codex/accounts"))
AUTH_JSON = Path(os.path.expanduser("~/.codex/auth.json"))
REFRESH_URL = "https://auth.openai.com/oauth/token"
CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"

# Refresh when less than this many seconds remain on the access_token
REFRESH_THRESHOLD_SECS = 48 * 3600  # 48 hours

# How often to check (in daemon mode)
CHECK_INTERVAL_SECS = 2 * 3600  # 2 hours

# Delay between refreshing individual accounts (avoid rate limits)
STAGGER_DELAY_SECS = 5

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [codex-refresh] %(levelname)s %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("codex-refresh")


def decode_jwt_expiry(token: str) -> float | None:
    """Decode a JWT and return the exp timestamp, or None."""
    try:
        payload = token.split(".")[1]
        payload += "=" * (4 - len(payload) % 4)
        claims = json.loads(base64.urlsafe_b64decode(payload))
        return claims.get("exp")
    except Exception:
        return None


def load_accounts() -> list[tuple[Path, dict]]:
    """Load all account files from ~/.codex/accounts/."""
    accounts = []
    if not ACCOUNTS_DIR.is_dir():
        return accounts
    for f in sorted(ACCOUNTS_DIR.glob("*.json")):
        try:
            with open(f) as fh:
                data = json.load(fh)
            if data.get("auth_mode") == "chatgpt" and data.get("tokens", {}).get("access_token"):
                accounts.append((f, data))
        except Exception as e:
            log.warning("Failed to load %s: %s", f.name, e)
    return accounts


def refresh_account(path: Path, data: dict) -> bool:
    """Refresh a single account's tokens. Returns True if refreshed."""
    email = data.get("email", path.stem)
    tokens = data.get("tokens", {})
    rt = tokens.get("refresh_token")

    if not rt:
        log.warning("%s: no refresh_token, skipping", email)
        return False

    try:
        body = urllib.parse.urlencode({
            "grant_type": "refresh_token",
            "refresh_token": rt,
            "client_id": CLIENT_ID,
        }).encode()
        req = urllib.request.Request(
            REFRESH_URL,
            data=body,
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            result = json.loads(resp.read())

        new_at = result.get("access_token")
        new_rt = result.get("refresh_token")

        if not new_at:
            log.error("%s: refresh response missing access_token", email)
            return False

        # Update tokens
        tokens["access_token"] = new_at
        if new_rt:
            tokens["refresh_token"] = new_rt

        # Save back to disk
        with open(path, "w") as fh:
            json.dump(data, fh, indent=2)

        # Check new expiry
        new_exp = decode_jwt_expiry(new_at)
        remaining = (new_exp - time.time()) / 3600 if new_exp else "?"
        log.info("%s: refreshed OK (%.1fh remaining)", email, remaining)
        return True

    except urllib.error.HTTPError as e:
        body = ""
        try:
            body = e.read().decode()[:200]
        except Exception:
            pass
        log.error("%s: HTTP %d — %s", email, e.code, body)
        return False
    except Exception as e:
        log.error("%s: refresh failed — %s", email, e)
        return False


def update_auth_json():
    """Copy the first valid account to ~/.codex/auth.json for CLI compat."""
    accounts = load_accounts()
    if accounts:
        path, data = accounts[0]
        try:
            with open(AUTH_JSON, "w") as fh:
                json.dump(data, fh, indent=2)
        except Exception as e:
            log.warning("Failed to update auth.json: %s", e)


def check_and_refresh():
    """Check all accounts and refresh those nearing expiry."""
    accounts = load_accounts()
    if not accounts:
        log.warning("No accounts found in %s", ACCOUNTS_DIR)
        return

    refreshed = 0
    for path, data in accounts:
        email = data.get("email", path.stem)
        tokens = data.get("tokens", {})
        at = tokens.get("access_token", "")

        exp = decode_jwt_expiry(at)
        if exp is None:
            log.warning("%s: cannot decode token expiry, refreshing", email)
            if refresh_account(path, data):
                refreshed += 1
            time.sleep(STAGGER_DELAY_SECS)
            continue

        remaining = exp - time.time()
        remaining_h = remaining / 3600

        if remaining < REFRESH_THRESHOLD_SECS:
            log.info("%s: %.1fh remaining (threshold: %dh), refreshing...",
                     email, remaining_h, REFRESH_THRESHOLD_SECS // 3600)
            if refresh_account(path, data):
                refreshed += 1
            time.sleep(STAGGER_DELAY_SECS)
        else:
            log.debug("%s: %.1fh remaining, OK", email, remaining_h)

    if refreshed > 0:
        update_auth_json()
        log.info("Refreshed %d/%d accounts", refreshed, len(accounts))
    else:
        log.info("All %d accounts OK (>%dh remaining)",
                 len(accounts), REFRESH_THRESHOLD_SECS // 3600)


def show_status():
    """Print token status for all accounts."""
    accounts = load_accounts()
    if not accounts:
        print("No accounts found")
        return

    now = time.time()
    for path, data in accounts:
        email = data.get("email", path.stem)
        tokens = data.get("tokens", {})
        at = tokens.get("access_token", "")
        rt = tokens.get("refresh_token", "")

        exp = decode_jwt_expiry(at)
        if exp:
            remaining_h = (exp - now) / 3600
            exp_str = time.strftime("%Y-%m-%d %H:%M", time.localtime(exp))
            status = f"{remaining_h:.1f}h remaining (expires {exp_str})"
            if remaining_h < 0:
                status = f"EXPIRED ({exp_str})"
            elif remaining_h < REFRESH_THRESHOLD_SECS / 3600:
                status += " [NEEDS REFRESH]"
        else:
            status = "cannot decode expiry"

        print(f"  {email}:")
        print(f"    access_token:  {status}")
        print(f"    refresh_token: {'yes' if rt else 'MISSING'}")
        print()


def daemon_loop():
    """Run check_and_refresh in a loop forever."""
    log.info("Starting daemon (check every %ds / %.1fh)",
             CHECK_INTERVAL_SECS, CHECK_INTERVAL_SECS / 3600)
    while True:
        try:
            check_and_refresh()
        except Exception as e:
            log.error("Unexpected error in refresh cycle: %s", e)
        time.sleep(CHECK_INTERVAL_SECS)


def main():
    parser = argparse.ArgumentParser(description="Codex OAuth token refresh daemon")
    parser.add_argument("--daemon", action="store_true",
                        help="Run forever, checking every 2 hours")
    parser.add_argument("--status", action="store_true",
                        help="Show token status and exit")
    args = parser.parse_args()

    if args.status:
        show_status()
    elif args.daemon:
        daemon_loop()
    else:
        check_and_refresh()


if __name__ == "__main__":
    main()
