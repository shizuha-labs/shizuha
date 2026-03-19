"""Agent definitions, paths, timeouts, and shared configuration.

CREDENTIAL POLICY:
- No host credential files are ever mounted into containers.
- All auth tokens are loaded from .env file (never from host env or hardcoded).
- Missing credentials fail loudly at import time.
"""

import os
import json
import random
import shutil
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import dotenv_values

BASE_DIR = Path(__file__).resolve().parent
TASKS_FILE = BASE_DIR / "tasks" / "tasks.yaml"
RESULTS_DIR = BASE_DIR / "results"
REPORTS_DIR = BASE_DIR / "reports"
TEMPLATE_DIR = BASE_DIR / "templates"
LOGS_DIR = BASE_DIR / "logs"
EVAL_IMAGE = "bench-eval:latest"
AGENT_IMAGE = "bench-agent:latest"
DOCKERFILE_PATH = BASE_DIR / "docker" / "Dockerfile.eval"
AGENT_DOCKERFILE_PATH = BASE_DIR / "docker" / "Dockerfile.agent"

# ── Load credentials from .env (explicit only, no fallbacks) ──
_dotenv = dotenv_values(BASE_DIR / ".env")


def _require_env(key: str) -> str:
    """Get a value from .env. Fails loudly if missing."""
    val = _dotenv.get(key)
    if not val:
        raise RuntimeError(
            f"Missing required credential: {key}\n"
            f"Add it to {BASE_DIR / '.env'}"
        )
    return val


# ── Optional LiteLLM proxy (GitHub Copilot → OpenAI-compatible API) ──
# When set, codex-based agents use this proxy instead of ChatGPT backend.
# Start with: cd litellm && litellm --config config.yaml --port 4000
LITELLM_PROXY_URL = _dotenv.get("LITELLM_PROXY_URL", "")

CLAUDE_OAUTH_TOKEN = _require_env("CLAUDE_CODE_OAUTH_TOKEN")
CLAUDE_OAUTH_TOKEN_2 = _dotenv.get("CLAUDE_CODE_OAUTH_TOKEN_2") or CLAUDE_OAUTH_TOKEN

CLAUDE_IDENTITY = {
    "userID": _require_env("CLAUDE_USER_ID"),
    "accountUuid": _require_env("CLAUDE_ACCOUNT_UUID"),
    "organizationUuid": _require_env("CLAUDE_ORG_UUID"),
}


def _read_claude_accounts() -> str:
    """Read all Claude OAuth tokens from .env (CLAUDE_CODE_OAUTH_TOKEN, _2, _3, ...).
    Returns a JSON array of account objects for multi-token rotation."""
    accounts = []
    # Primary token
    token = _dotenv.get("CLAUDE_CODE_OAUTH_TOKEN")
    if token:
        accounts.append({"token": token, "label": "primary"})
    # Additional tokens: CLAUDE_CODE_OAUTH_TOKEN_2, _3, ...
    for i in range(2, 10):
        token = _dotenv.get(f"CLAUDE_CODE_OAUTH_TOKEN_{i}")
        if token:
            accounts.append({"token": token, "label": f"token_{i}"})
    return json.dumps(accounts)


CLAUDE_ACCOUNTS_JSON = _read_claude_accounts()


def _claude_container_setup_cmd() -> str:
    """Bash snippet that writes Claude account pool files inside the container.
    Reads CLAUDE_ACCOUNTS_JSON env var and creates ~/.claude/accounts/<label>.json files.
    Also writes the primary token as CLAUDE_CODE_OAUTH_TOKEN for backwards compat."""
    return (
        'mkdir -p "$HOME/.claude/accounts" && '
        'echo "$CLAUDE_ACCOUNTS_JSON" | python3 -c '
        "'"
        'import json,sys,os;'
        'accounts=json.load(sys.stdin);'
        'home=os.environ["HOME"];'
        '[open(home+"/.claude/accounts/"+a.get("label","token_"+str(i))+".json","w").write(json.dumps(a)) for i,a in enumerate(accounts)]'
        "'"
        ' && '
    )


def _read_codex_auth() -> str:
    """Read ~/.codex/auth.json and return its contents as a string.
    This is injected as an env var into containers — no host file mount."""
    try:
        auth_path = os.path.expanduser("~/.codex/auth.json")
        with open(auth_path) as f:
            return f.read().strip()
    except Exception:
        return "{}"


def _read_codex_accounts(only_emails: list[str] | None = None) -> str:
    """Read Codex account files from ~/.codex/accounts/*.json.
    Returns a JSON array of account objects. Falls back to single auth.json.
    If only_emails is set, filter to only those accounts.
    Also respects CODEX_ONLY_EMAILS env var (comma-separated) for filtering.
    NOTE: Does NOT refresh tokens — the codex CLI handles its own token
    refresh internally. Single-use refresh tokens mean we must not consume
    them before the CLI gets a chance to."""
    # Allow env var override for account filtering
    if only_emails is None:
        env_filter = os.environ.get("CODEX_ONLY_EMAILS", "")
        if env_filter:
            only_emails = [e.strip() for e in env_filter.split(",") if e.strip()]
    accounts_dir = Path(os.path.expanduser("~/.codex/accounts"))
    accounts = []
    try:
        if accounts_dir.is_dir():
            for f in sorted(accounts_dir.glob("*.json")):
                try:
                    with open(f) as fh:
                        data = json.loads(fh.read().strip())
                        if data.get("auth_mode") == "chatgpt" and data.get("tokens", {}).get("access_token"):
                            if only_emails and data.get("email") not in only_emails:
                                continue
                            accounts.append(data)
                except Exception:
                    continue
    except Exception:
        pass
    # Fallback to single auth.json if no accounts found
    if not accounts:
        try:
            auth_path = os.path.expanduser("~/.codex/auth.json")
            with open(auth_path) as f:
                data = json.loads(f.read().strip())
                if data.get("auth_mode") == "chatgpt":
                    accounts.append(data)
        except Exception:
            pass
    return json.dumps(accounts)


def _codex_container_setup_cmd() -> str:
    """Bash snippet that writes account pool files inside the container.
    Reads CODEX_ACCOUNTS_JSON env var and creates ~/.codex/accounts/<email>.json files.
    Also writes the first account as ~/.codex/auth.json for codex CLI compatibility.

    IMPORTANT: Strips refresh_token from all accounts to prevent the codex CLI
    from trying to refresh (single-use tokens cause conflicts when multiple
    containers share the same account pool). The fresh access_token is used directly.
    """
    # Note: the python3 -c argument is in bash single quotes, so double quotes are safe
    # inside. The JSON is piped via stdin to avoid shell expansion issues.
    return (
        'mkdir -p "$HOME/.codex/accounts" && '
        'echo "$CODEX_ACCOUNTS_JSON" | python3 -c '
        "'"
        'import json,sys,os;'
        'accounts=json.load(sys.stdin);'
        'home=os.environ["HOME"];'
        # Blank refresh_token so codex CLI cannot refresh (prevents token conflicts)
        '[a["tokens"].__setitem__("refresh_token","") for a in accounts];'
        '[open(home+"/.codex/accounts/"+a.get("email",a["tokens"]["account_id"])+".json","w").write(json.dumps(a)) for a in accounts];'
        'accounts and open(home+"/.codex/auth.json","w").write(json.dumps(accounts[0]))'
        "'"
        ' && '
    )


def _shizuha_credentials_setup_cmd() -> str:
    """Bash snippet that writes ~/.shizuha/credentials.json for shizuha agents.
    Converts CODEX_ACCOUNTS_JSON (Codex CLI format) to the shizuha credential store format.
    Must be chained AFTER _codex_container_setup_cmd()."""
    return (
        'echo "$CODEX_ACCOUNTS_JSON" | python3 -c '
        "'"
        'import json,sys,os;'
        'accounts=json.load(sys.stdin);'
        'home=os.environ["HOME"];'
        'cred_dir=home+"/.shizuha";'
        'os.makedirs(cred_dir,exist_ok=True);'
        'codex_entries=[{"email":a.get("email",""),"accessToken":a["tokens"]["access_token"],'
        '"refreshToken":"","accountId":a["tokens"].get("account_id",""),'
        '"addedAt":"2026-01-01T00:00:00Z"} for a in accounts];'
        'cred={"codex":{"accounts":codex_entries}};'
        'open(cred_dir+"/credentials.json","w").write(json.dumps(cred))'
        "'"
        ' && '
    )


def _shizuha_litellm_env() -> dict[str, str]:
    """Extra env vars for shizuha agents when LiteLLM proxy is configured.
    Sets CODEX_BASE_URL to redirect the codex provider to the proxy,
    and LITELLM_PROXY_URL so the registry can route claude-* models through it."""
    if not LITELLM_PROXY_URL:
        return {}
    # Shizuha's codex provider appends /responses to the base URL,
    # so we need to provide the base without /v1/responses.
    # LiteLLM serves at /v1/responses, so base is PROXY_URL/v1.
    base = LITELLM_PROXY_URL.rstrip("/")
    if not base.endswith("/v1"):
        base = base + "/v1"
    return {
        "CODEX_BASE_URL": base,
        "LITELLM_PROXY_URL": LITELLM_PROXY_URL,
    }


def _codex_exec_with_rotation_cmd(model: str) -> str:
    """Bash snippet that runs the native codex CLI with account pool rotation.

    The native codex CLI only reads ~/.codex/auth.json (one account).
    On failure (exit != 0), this wrapper rotates to the next account and
    retries until one succeeds or all are exhausted.

    NOTE: Python code uses ONLY double quotes (wrapped in bash single quotes).
    """
    return (
        'python3 -c '
        "'"
        'import subprocess,os,sys,glob,shutil\n'
        'home=os.environ["HOME"]\n'
        'auth=home+"/.codex/auth.json"\n'
        'accts=sorted(glob.glob(home+"/.codex/accounts/*.json"))\n'
        'if not accts: sys.exit("No codex accounts found")\n'
        'prompt=os.environ["BENCH_PROMPT"]\n'
        'ok=False\n'
        'for i,af in enumerate(accts):\n'
        '  shutil.copy(af,auth)\n'
        '  email=os.path.basename(af).replace(".json","")\n'
        '  sys.stderr.write("[codex-rotation] Trying account "+str(i+1)+"/"+str(len(accts))+": "+email+"\\n")\n'
        '  sys.stderr.flush()\n'
        f'  r=subprocess.run(["codex","exec",prompt,"--model","{model}","--sandbox","workspace-write","-C","/workspace","--json"])\n'
        '  if r.returncode==0:\n'
        '    ok=True;break\n'
        '  sys.stderr.write("[codex-rotation] Account "+email+" failed (exit "+str(r.returncode)+")\\n")\n'
        '  sys.stderr.flush()\n'
        'if not ok:\n'
        '  sys.stderr.write("[codex-rotation] All "+str(len(accts))+" accounts exhausted\\n")\n'
        '  sys.exit(1)\n'
        "'"
    )


def _codex_reasoning_effort_cmd(effort: str) -> str:
    """Bash snippet that appends model_reasoning_effort to ~/.codex/config.toml."""
    return (
        f'mkdir -p "$HOME/.codex" && '
        f'printf \'model_reasoning_effort = "{effort}"\\n\' >> "$HOME/.codex/config.toml" && '
    )


def _codex_litellm_config_toml_cmd() -> str:
    """Bash snippet that writes ~/.codex/config.toml pointing to LiteLLM proxy.
    Only used when LITELLM_PROXY_URL is configured.
    Uses printf instead of heredoc to avoid breaking && chains."""
    if not LITELLM_PROXY_URL:
        return ""
    # Use printf with escaped newlines — avoids heredoc syntax issues in && chains
    toml_content = (
        'model_provider = "litellm"\\n'
        '\\n'
        '[model_providers.litellm]\\n'
        'name = "LiteLLM"\\n'
        f'base_url = "{LITELLM_PROXY_URL}"\\n'
        'wire_api = "responses"\\n'
        'requires_openai_auth = false\\n'
        'supports_websockets = false\\n'
    )
    return f'printf \'{toml_content}\' > "$HOME/.codex/config.toml" && '


# Default timeouts per tier (seconds)
TIER_TIMEOUTS = {
    "easy": 120,
    "medium": 300,
    "hard": 900,
    "extreme": 1200,
    "nightmare": 1800,
    "impossible": 4200,
}


@dataclass
class ContainerConfig:
    """Configuration for running an agent inside a Docker container.
    NO host credential files are ever mounted — tokens via env vars only."""
    mounts: list[tuple[str, str, str]]  # (host_path, container_path, mode: "ro"|"rw")
    env: dict[str, str]  # Explicit env vars (NO host env leak)
    command: list[str]  # Command to run inside the container
    extra_docker_args: list[str] = field(default_factory=list)  # Additional docker run flags


@dataclass
class AgentConfig:
    """Base agent config. All execution is container-only."""
    name: str
    model: str
    binary: str
    version: str = "unknown"
    build_cmd: list[str] = field(default_factory=list)

    def container_config(self, prompt: str, workspace: str) -> ContainerConfig:
        """Return container configuration for this agent. Override per agent type."""
        raise NotImplementedError(f"{self.name} does not support container execution")

    def move_command(self, prompt_env_var: str = "MOVE_PROMPT") -> list[str]:
        """CLI command to query agent for a single chess move.
        The prompt is passed via the environment variable named by prompt_env_var."""
        raise NotImplementedError(f"{self.name} does not support move_command")

    def supports_visual_battle(self) -> bool:
        """Whether this agent supports visual chess battles."""
        return False

    def has_vision(self) -> bool:
        """Whether this agent can read images (PNG) via its tool loop.
        Vision agents use screenshots; non-vision agents use /api/state JSON."""
        return False

    def visual_container_config(
        self, prompt: str, workspace: str, server_hostname: str = "chess-server",
    ) -> ContainerConfig:
        """Return container config for a long-running visual chess agent.
        The agent runs autonomously, taking screenshots and making HTTP moves."""
        raise NotImplementedError(f"{self.name} does not support visual battles")


class ShizuhaAgent(AgentConfig):
    """Shizuha agent using gpt-5.3-codex via Codex OAuth token."""
    def __init__(self):
        super().__init__(
            name="shizuha",
            model="gpt-5.3-codex",
            binary="shizuha",
        )

    def move_command(self, prompt_env_var: str = "MOVE_PROMPT") -> list[str]:
        return ["bash", "-c",
                f'node /opt/shizuha/dist/shizuha.js exec '
                f'--prompt "${prompt_env_var}" --model {self.model} --max-turns 0 --json']

    def container_config(self, prompt: str, workspace: str) -> ContainerConfig:
        shizuha_src = Path(os.path.expanduser("~")) / "work" / "shizuha-stack" / "shizuha"
        codex_accounts = _read_codex_accounts()
        return ContainerConfig(
            mounts=[
                (str(shizuha_src), "/opt/shizuha", "ro"),
                (workspace, "/workspace", "rw"),
                # NO host credential files mounted
            ],
            env={
                "NO_COLOR": "1", "HOME": "/home/bench",
                "PATH": "/usr/local/bin:/usr/bin:/bin:/opt/shizuha/node_modules/.bin",
                "CODEX_ACCOUNTS_JSON": codex_accounts,
                "BENCH_PROMPT": prompt,
                **_shizuha_litellm_env(),
            },
            command=[
                "bash", "-c",
                _codex_container_setup_cmd() +
                'exec node /opt/shizuha/dist/shizuha.js '
                f'exec --prompt "$BENCH_PROMPT" --cwd /workspace '
                f'--model {self.model} --mode autonomous --max-turns 0 --json',
            ],
        )

    def supports_visual_battle(self) -> bool:
        return True

    def visual_container_config(
        self, prompt: str, workspace: str, server_hostname: str = "chess-server",
    ) -> ContainerConfig:
        shizuha_src = Path(os.path.expanduser("~")) / "work" / "shizuha-stack" / "shizuha"
        codex_accounts = _read_codex_accounts()
        return ContainerConfig(
            mounts=[
                (str(shizuha_src), "/opt/shizuha", "ro"),
                (workspace, "/workspace", "rw"),
            ],
            env={
                "NO_COLOR": "1", "HOME": "/home/bench",
                "PATH": "/usr/local/bin:/usr/bin:/bin:/opt/shizuha/node_modules/.bin",
                "CODEX_ACCOUNTS_JSON": codex_accounts,
                "BENCH_PROMPT": prompt,
                **_shizuha_litellm_env(),
            },
            command=[
                "bash", "-c",
                _codex_container_setup_cmd() +
                'exec node /opt/shizuha/dist/shizuha.js '
                f'exec --prompt "$BENCH_PROMPT" --cwd /workspace '
                f'--model {self.model} --mode autonomous --max-turns 0 --json',
            ],
        )


class ShizuhaXHighAgent(AgentConfig):
    """Shizuha agent using gpt-5.3-xhigh (high-reasoning model) via Codex OAuth token.
    NO host credentials mounted."""
    def __init__(self):
        super().__init__(
            name="shizuha-xhigh",
            model="gpt-5.3-xhigh",
            binary="shizuha",
        )

    def move_command(self, prompt_env_var: str = "MOVE_PROMPT") -> list[str]:
        return ["bash", "-c",
                f'node /opt/shizuha/dist/shizuha.js exec '
                f'--prompt "${prompt_env_var}" --model {self.model} --max-turns 0 --json']

    def container_config(self, prompt: str, workspace: str) -> ContainerConfig:
        shizuha_src = Path(os.path.expanduser("~")) / "work" / "shizuha-stack" / "shizuha"
        codex_accounts = _read_codex_accounts()
        return ContainerConfig(
            mounts=[
                (str(shizuha_src), "/opt/shizuha", "ro"),
                (workspace, "/workspace", "rw"),
            ],
            env={
                "NO_COLOR": "1", "HOME": "/home/bench",
                "PATH": "/usr/local/bin:/usr/bin:/bin:/opt/shizuha/node_modules/.bin",
                "CODEX_ACCOUNTS_JSON": codex_accounts,
                "BENCH_PROMPT": prompt,
                **_shizuha_litellm_env(),
            },
            command=[
                "bash", "-c",
                _codex_container_setup_cmd() +
                'exec node /opt/shizuha/dist/shizuha.js '
                f'exec --prompt "$BENCH_PROMPT" --cwd /workspace '
                f'--model {self.model} --mode autonomous --max-turns 0 --json',
            ],
        )

    def supports_visual_battle(self) -> bool:
        return True

    def visual_container_config(
        self, prompt: str, workspace: str, server_hostname: str = "chess-server",
    ) -> ContainerConfig:
        shizuha_src = Path(os.path.expanduser("~")) / "work" / "shizuha-stack" / "shizuha"
        codex_accounts = _read_codex_accounts()
        return ContainerConfig(
            mounts=[
                (str(shizuha_src), "/opt/shizuha", "ro"),
                (workspace, "/workspace", "rw"),
            ],
            env={
                "NO_COLOR": "1", "HOME": "/home/bench",
                "PATH": "/usr/local/bin:/usr/bin:/bin:/opt/shizuha/node_modules/.bin",
                "CODEX_ACCOUNTS_JSON": codex_accounts,
                "BENCH_PROMPT": prompt,
                **_shizuha_litellm_env(),
            },
            command=[
                "bash", "-c",
                _codex_container_setup_cmd() +
                'exec node /opt/shizuha/dist/shizuha.js '
                f'exec --prompt "$BENCH_PROMPT" --cwd /workspace '
                f'--model {self.model} --mode autonomous --max-turns 0 --json',
            ],
        )


class ShizuhaCodexXHighAgent(AgentConfig):
    """Shizuha agent using gpt-5.3-codex with explicit xhigh reasoning."""
    def __init__(self):
        super().__init__(
            name="shizuha-codex-xhigh",
            model="gpt-5.3-codex",
            binary="shizuha",
        )

    def move_command(self, prompt_env_var: str = "MOVE_PROMPT") -> list[str]:
        return ["bash", "-c",
                f'node /opt/shizuha/dist/shizuha.js exec '
                f'--prompt "${prompt_env_var}" --model {self.model} --effort xhigh --max-turns 0 --json']

    def container_config(self, prompt: str, workspace: str) -> ContainerConfig:
        shizuha_src = Path(os.path.expanduser("~")) / "work" / "shizuha-stack" / "shizuha"
        codex_accounts = _read_codex_accounts()
        return ContainerConfig(
            mounts=[
                (str(shizuha_src), "/opt/shizuha", "ro"),
                (workspace, "/workspace", "rw"),
            ],
            env={
                "NO_COLOR": "1", "HOME": "/home/bench",
                "PATH": "/usr/local/bin:/usr/bin:/bin:/opt/shizuha/node_modules/.bin",
                "CODEX_ACCOUNTS_JSON": codex_accounts,
                "BENCH_PROMPT": prompt,
                **_shizuha_litellm_env(),
            },
            command=[
                "bash", "-c",
                _codex_container_setup_cmd() +
                _shizuha_credentials_setup_cmd() +
                'exec node /opt/shizuha/dist/shizuha.js '
                f'exec --prompt "$BENCH_PROMPT" --cwd /workspace '
                f'--model {self.model} --effort xhigh --mode autonomous --max-turns 0 --json',
            ],
        )

    def supports_visual_battle(self) -> bool:
        return True

    def visual_container_config(
        self, prompt: str, workspace: str, server_hostname: str = "chess-server",
    ) -> ContainerConfig:
        shizuha_src = Path(os.path.expanduser("~")) / "work" / "shizuha-stack" / "shizuha"
        codex_accounts = _read_codex_accounts()
        return ContainerConfig(
            mounts=[
                (str(shizuha_src), "/opt/shizuha", "ro"),
                (workspace, "/workspace", "rw"),
            ],
            env={
                "NO_COLOR": "1", "HOME": "/home/bench",
                "PATH": "/usr/local/bin:/usr/bin:/bin:/opt/shizuha/node_modules/.bin",
                "CODEX_ACCOUNTS_JSON": codex_accounts,
                "BENCH_PROMPT": prompt,
                **_shizuha_litellm_env(),
            },
            command=[
                "bash", "-c",
                _codex_container_setup_cmd() +
                _shizuha_credentials_setup_cmd() +
                'exec node /opt/shizuha/dist/shizuha.js '
                f'exec --prompt "$BENCH_PROMPT" --cwd /workspace '
                f'--model {self.model} --effort xhigh --mode autonomous --max-turns 0 --json',
            ],
        )


class ShizuhaGPT54XHighAgent(ShizuhaCodexXHighAgent):
    """Shizuha agent using gpt-5.4 with xhigh reasoning effort."""
    def __init__(self):
        super().__init__()
        self.name = "shizuha-gpt-5.4-xhigh"
        self.model = "gpt-5.4"


# Keep old name as alias so `--agents shizuha-gpt-5.4-xhigh-thinking` still works
ShizuhaGPT54XHighThinkingAgent = ShizuhaGPT54XHighAgent


class ShizuhaCodexSparkXHighAgent(AgentConfig):
    """Shizuha agent using gpt-5.3-codex-spark with xhigh reasoning."""
    def __init__(self):
        super().__init__(
            name="shizuha-codex-spark-xhigh",
            model="gpt-5.3-codex-spark",
            binary="shizuha",
        )

    def move_command(self, prompt_env_var: str = "MOVE_PROMPT") -> list[str]:
        return ["bash", "-c",
                f'node /opt/shizuha/dist/shizuha.js exec '
                f'--prompt "${prompt_env_var}" --model {self.model} --effort xhigh --max-turns 0 --json']

    def container_config(self, prompt: str, workspace: str) -> ContainerConfig:
        shizuha_src = Path(os.path.expanduser("~")) / "work" / "shizuha-stack" / "shizuha"
        codex_accounts = _read_codex_accounts()
        return ContainerConfig(
            mounts=[
                (str(shizuha_src), "/opt/shizuha", "ro"),
                (workspace, "/workspace", "rw"),
            ],
            env={
                "NO_COLOR": "1", "HOME": "/home/bench",
                "PATH": "/usr/local/bin:/usr/bin:/bin:/opt/shizuha/node_modules/.bin",
                "CODEX_ACCOUNTS_JSON": codex_accounts,
                "BENCH_PROMPT": prompt,
                **_shizuha_litellm_env(),
            },
            command=[
                "bash", "-c",
                _codex_container_setup_cmd() +
                _shizuha_credentials_setup_cmd() +
                'exec node /opt/shizuha/dist/shizuha.js '
                f'exec --prompt "$BENCH_PROMPT" --cwd /workspace '
                f'--model {self.model} --effort xhigh --mode autonomous --max-turns 0 --json',
            ],
        )

    def supports_visual_battle(self) -> bool:
        return True

    def visual_container_config(
        self, prompt: str, workspace: str, server_hostname: str = "chess-server",
    ) -> ContainerConfig:
        shizuha_src = Path(os.path.expanduser("~")) / "work" / "shizuha-stack" / "shizuha"
        codex_accounts = _read_codex_accounts()
        return ContainerConfig(
            mounts=[
                (str(shizuha_src), "/opt/shizuha", "ro"),
                (workspace, "/workspace", "rw"),
            ],
            env={
                "NO_COLOR": "1", "HOME": "/home/bench",
                "PATH": "/usr/local/bin:/usr/bin:/bin:/opt/shizuha/node_modules/.bin",
                "CODEX_ACCOUNTS_JSON": codex_accounts,
                "BENCH_PROMPT": prompt,
                **_shizuha_litellm_env(),
            },
            command=[
                "bash", "-c",
                _codex_container_setup_cmd() +
                _shizuha_credentials_setup_cmd() +
                'exec node /opt/shizuha/dist/shizuha.js '
                f'exec --prompt "$BENCH_PROMPT" --cwd /workspace '
                f'--model {self.model} --effort xhigh --mode autonomous --max-turns 0 --json',
            ],
        )


class CodexAgent(AgentConfig):
    """Native Codex CLI using gpt-5.3-codex.
    NO host credentials mounted — codex auth passed via env var."""
    def __init__(self):
        super().__init__(
            name="codex",
            model="gpt-5.3-codex",
            binary="codex",
        )

    def move_command(self, prompt_env_var: str = "MOVE_PROMPT") -> list[str]:
        return ["bash", "-c",
                f'codex exec "${prompt_env_var}" --model {self.model} '
                f'--skip-git-repo-check --json']

    def container_config(self, prompt: str, workspace: str) -> ContainerConfig:
        codex_accounts = _read_codex_accounts()
        return ContainerConfig(
            mounts=[
                # Codex CLI installed globally in container image (no host binary mount)
                (workspace, "/workspace", "rw"),
            ],
            env={
                "NO_COLOR": "1", "HOME": "/home/bench",
                "PATH": "/usr/local/bin:/usr/bin:/bin",
                "CODEX_ACCOUNTS_JSON": codex_accounts,
                "BENCH_PROMPT": prompt,
            },
            command=[
                "bash", "-c",
                _codex_container_setup_cmd() +
                _codex_litellm_config_toml_cmd() +
                'exec ' + _codex_exec_with_rotation_cmd(self.model),
            ],
        )

    def supports_visual_battle(self) -> bool:
        return True

    def visual_container_config(
        self, prompt: str, workspace: str, server_hostname: str = "chess-server",
    ) -> ContainerConfig:
        codex_accounts = _read_codex_accounts()
        return ContainerConfig(
            mounts=[
                (workspace, "/workspace", "rw"),
            ],
            env={
                "NO_COLOR": "1", "HOME": "/home/bench",
                "PATH": "/usr/local/bin:/usr/bin:/bin",
                "CODEX_ACCOUNTS_JSON": codex_accounts,
                "BENCH_PROMPT": prompt,
            },
            command=[
                "bash", "-c",
                _codex_container_setup_cmd() +
                _codex_litellm_config_toml_cmd() +
                'cd /workspace && git init -q && '
                'exec ' + _codex_exec_with_rotation_cmd(self.model),
            ],
        )


class ShizuhaClaudeAgent(AgentConfig):
    """Shizuha agent using claude-opus-4-6 via Claude Code OAuth token pool.
    NO host credentials mounted — tokens passed via env var, identity via generated .claude.json."""
    def __init__(self):
        super().__init__(
            name="shizuha-claude",
            model="claude-opus-4-6",
            binary="shizuha",
        )

    def move_command(self, prompt_env_var: str = "MOVE_PROMPT") -> list[str]:
        return ["bash", "-c",
                f'node /opt/shizuha/dist/shizuha.js exec '
                f'--prompt "${prompt_env_var}" --model {self.model} --max-turns 0 --json']

    def container_config(self, prompt: str, workspace: str) -> ContainerConfig:
        shizuha_src = Path(os.path.expanduser("~")) / "work" / "shizuha-stack" / "shizuha"
        # Minimal .claude.json with only identity fields (for API fingerprinting, no tokens)
        identity_json = json.dumps({
            "userID": CLAUDE_IDENTITY["userID"],
            "oauthAccount": {
                "accountUuid": CLAUDE_IDENTITY["accountUuid"],
                "organizationUuid": CLAUDE_IDENTITY["organizationUuid"],
            },
        })
        return ContainerConfig(
            mounts=[
                (str(shizuha_src), "/opt/shizuha", "ro"),
                (workspace, "/workspace", "rw"),
                # NO host credential files mounted
            ],
            env={
                "NO_COLOR": "1", "HOME": "/home/bench",
                "PATH": "/usr/local/bin:/usr/bin:/bin:/opt/shizuha/node_modules/.bin",
                "CLAUDE_CODE_OAUTH_TOKEN": CLAUDE_OAUTH_TOKEN,
                "CLAUDE_ACCOUNTS_JSON": CLAUDE_ACCOUNTS_JSON,
                "CLAUDE_IDENTITY_JSON": identity_json,
                "CLAUDE_CODE_MAX_OUTPUT_TOKENS": "128000",
                "BENCH_PROMPT": prompt,
            },
            command=[
                "bash", "-c",
                # Write identity + account pool, then run agent
                'echo "$CLAUDE_IDENTITY_JSON" > "$HOME/.claude.json" && ' +
                _claude_container_setup_cmd() +
                'exec node /opt/shizuha/dist/shizuha.js '
                'exec --prompt "$BENCH_PROMPT" --cwd /workspace '
                '--model claude-opus-4-6 --mode autonomous --max-turns 0 --thinking high --json',
            ],
        )

    def supports_visual_battle(self) -> bool:
        return True

    def has_vision(self) -> bool:
        return True

    def visual_container_config(
        self, prompt: str, workspace: str, server_hostname: str = "chess-server",
    ) -> ContainerConfig:
        shizuha_src = Path(os.path.expanduser("~")) / "work" / "shizuha-stack" / "shizuha"
        identity_json = json.dumps({
            "userID": CLAUDE_IDENTITY["userID"],
            "oauthAccount": {
                "accountUuid": CLAUDE_IDENTITY["accountUuid"],
                "organizationUuid": CLAUDE_IDENTITY["organizationUuid"],
            },
        })
        return ContainerConfig(
            mounts=[
                (str(shizuha_src), "/opt/shizuha", "ro"),
                (workspace, "/workspace", "rw"),
            ],
            env={
                "NO_COLOR": "1", "HOME": "/home/bench",
                "PATH": "/usr/local/bin:/usr/bin:/bin:/opt/shizuha/node_modules/.bin",
                "CLAUDE_CODE_OAUTH_TOKEN": CLAUDE_OAUTH_TOKEN,
                "CLAUDE_ACCOUNTS_JSON": CLAUDE_ACCOUNTS_JSON,
                "CLAUDE_IDENTITY_JSON": identity_json,
                "BENCH_PROMPT": prompt,
            },
            command=[
                "bash", "-c",
                'echo "$CLAUDE_IDENTITY_JSON" > "$HOME/.claude.json" && ' +
                _claude_container_setup_cmd() +
                'exec node /opt/shizuha/dist/shizuha.js '
                'exec --prompt "$BENCH_PROMPT" --cwd /workspace '
                '--model claude-opus-4-6 --mode autonomous --max-turns 0 --json',
            ],
        )


class ClaudeOpusAgent(AgentConfig):
    """Claude Code CLI using claude-opus-4-6.
    NO host credentials mounted — OAuth token + identity passed via env vars.
    Supports token pool rotation: tries primary token first, if rate-limited
    swaps to secondary token and retries."""
    def __init__(self):
        super().__init__(
            name="claude-opus",
            model="claude-opus-4-6",
            binary="claude",
        )

    def move_command(self, prompt_env_var: str = "MOVE_PROMPT") -> list[str]:
        return ["bash", "-c",
                f'claude -p "${prompt_env_var}" --model opus --max-turns 0 '
                '--output-format json --effort high --allowedTools ""']

    def container_config(self, prompt: str, workspace: str) -> ContainerConfig:
        claude_bin = shutil.which("claude") or "/usr/local/bin/claude"
        # Build credentials for ALL tokens in the pool (randomized for load balancing)
        accounts = json.loads(CLAUDE_ACCOUNTS_JSON)
        random.shuffle(accounts)  # spread load across tokens each run
        creds_env = {}
        for i, acct in enumerate(accounts):
            creds_env[f"CLAUDE_CREDS_{i + 1}"] = json.dumps({
                "claudeAiOauth": {
                    "accessToken": acct["token"],
                    "refreshToken": "",
                    "expiresAt": 9999999999999,
                    "scopes": ["user:inference"],
                }
            })
        identity_json = json.dumps({
            "userID": CLAUDE_IDENTITY["userID"],
            "oauthAccount": {
                "accountUuid": CLAUDE_IDENTITY["accountUuid"],
                "organizationUuid": CLAUDE_IDENTITY["organizationUuid"],
            },
            "hasCompletedOnboarding": True,
        })
        claude_cmd = (
            'claude -p "$BENCH_PROMPT" '
            '--model opus --output-format json '
            '--effort high '
            '--max-turns 0 '
            '--allowedTools Bash,Write,Read,Edit,Glob,Grep'
        )
        setup = (
            'mkdir -p "$HOME/.claude" && '
            'echo "$CLAUDE_IDENTITY_JSON" > "$HOME/.claude.json"'
        )
        n = len(accounts)
        if n > 1:
            rotation_parts = [setup]
            for i in range(n):
                creds_var = f"CLAUDE_CREDS_{i + 1}"
                label = accounts[i]["label"]
                if i == 0:
                    rotation_parts.append(
                        f' && echo "${creds_var}" > "$HOME/.claude/.credentials.json"'
                        f' && echo "[claude-rotation] Trying token {i + 1}/{n}: {label}" >&2'
                        f' && {claude_cmd} 2>&1 | tee /tmp/claude_out.txt'
                    )
                else:
                    rotation_parts.append(
                        f' ; if grep -q "hit your limit" /tmp/claude_out.txt 2>/dev/null; then'
                        f'   echo "[claude-rotation] Token {i}/{n} rate-limited, trying {label}" >&2 ;'
                        f'   echo "${creds_var}" > "$HOME/.claude/.credentials.json" ;'
                    )
                    if i == n - 1:
                        rotation_parts.append(f'   exec {claude_cmd} ; fi')
                    else:
                        rotation_parts.append(
                            f'   {claude_cmd} 2>&1 | tee /tmp/claude_out.txt ; fi'
                        )
            run_script = ''.join(rotation_parts)
        else:
            run_script = (
                setup +
                ' && echo "$CLAUDE_CREDS_1" > "$HOME/.claude/.credentials.json"'
                f' && exec {claude_cmd}'
            )
        return ContainerConfig(
            mounts=[
                (claude_bin, "/usr/local/bin/claude", "ro"),
                (workspace, "/workspace", "rw"),
            ],
            env={
                "NO_COLOR": "1", "HOME": "/home/bench",
                "PATH": "/usr/local/bin:/usr/bin:/bin",
                "CLAUDE_CODE_MAX_OUTPUT_TOKENS": "128000",
                **creds_env,
                "CLAUDE_IDENTITY_JSON": identity_json,
                "BENCH_PROMPT": prompt,
            },
            command=["bash", "-c", run_script],
        )

    def supports_visual_battle(self) -> bool:
        return True

    def has_vision(self) -> bool:
        return True

    def visual_container_config(
        self, prompt: str, workspace: str, server_hostname: str = "chess-server",
    ) -> ContainerConfig:
        claude_bin = shutil.which("claude") or "/usr/local/bin/claude"
        # Build credentials for ALL tokens in the pool (randomized for load balancing)
        accounts = json.loads(CLAUDE_ACCOUNTS_JSON)
        random.shuffle(accounts)  # spread load across tokens each run
        creds_env = {}
        for i, acct in enumerate(accounts):
            creds = json.dumps({
                "claudeAiOauth": {
                    "accessToken": acct["token"],
                    "refreshToken": "",
                    "expiresAt": 9999999999999,
                    "scopes": ["user:inference"],
                }
            })
            creds_env[f"CLAUDE_CREDS_{i + 1}"] = creds
        identity_json = json.dumps({
            "userID": CLAUDE_IDENTITY["userID"],
            "oauthAccount": {
                "accountUuid": CLAUDE_IDENTITY["accountUuid"],
                "organizationUuid": CLAUDE_IDENTITY["organizationUuid"],
            },
            "hasCompletedOnboarding": True,
        })
        claude_cmd = (
            'claude -p "$BENCH_PROMPT" '
            '--model opus --output-format json '
            '--effort high '
            '--max-turns 0 '
            '--allowedTools Bash,Read'
        )
        # Build rotation script: try each token, grep for "hit your limit"
        setup = (
            'mkdir -p "$HOME/.claude" && '
            'echo "$CLAUDE_IDENTITY_JSON" > "$HOME/.claude.json"'
        )
        n = len(accounts)
        if n > 1:
            # Try each token in sequence; on rate limit, swap to next
            rotation_parts = [setup]
            for i in range(n):
                creds_var = f"CLAUDE_CREDS_{i + 1}"
                label = accounts[i]["label"]
                if i == 0:
                    rotation_parts.append(
                        f' && echo "${creds_var}" > "$HOME/.claude/.credentials.json"'
                        f' && echo "[claude-rotation] Trying token {i + 1}/{n}: {label}" >&2'
                        f' && {claude_cmd} 2>&1 | tee /tmp/claude_out.txt'
                    )
                else:
                    rotation_parts.append(
                        f' ; if grep -q "hit your limit" /tmp/claude_out.txt 2>/dev/null; then'
                        f'   echo "[claude-rotation] Token {i}/{n} rate-limited, trying {label}" >&2 ;'
                        f'   echo "${creds_var}" > "$HOME/.claude/.credentials.json" ;'
                    )
                    if i == n - 1:
                        # Last token — exec (no more fallbacks)
                        rotation_parts.append(
                            f'   exec {claude_cmd} ;'
                            f' fi'
                        )
                    else:
                        rotation_parts.append(
                            f'   {claude_cmd} 2>&1 | tee /tmp/claude_out.txt ;'
                            f' fi'
                        )
            run_script = ''.join(rotation_parts)
        else:
            run_script = (
                setup +
                ' && echo "$CLAUDE_CREDS_1" > "$HOME/.claude/.credentials.json"'
                f' && exec {claude_cmd}'
            )
        return ContainerConfig(
            mounts=[
                (claude_bin, "/usr/local/bin/claude", "ro"),
                (workspace, "/workspace", "rw"),
            ],
            env={
                "NO_COLOR": "1", "HOME": "/home/bench",
                "PATH": "/usr/local/bin:/usr/bin:/bin",
                **creds_env,
                "CLAUDE_IDENTITY_JSON": identity_json,
                "BENCH_PROMPT": prompt,
            },
            command=["bash", "-c", run_script],
        )


class Shizuha51MaxAgent(AgentConfig):
    """Shizuha agent using gpt-5.1-codex-max (higher reasoning, free plan).
    NO host credentials mounted."""
    def __init__(self):
        super().__init__(
            name="shizuha-51max",
            model="gpt-5.1-codex-max",
            binary="shizuha",
        )

    def move_command(self, prompt_env_var: str = "MOVE_PROMPT") -> list[str]:
        return ["bash", "-c",
                f'node /opt/shizuha/dist/shizuha.js exec '
                f'--prompt "${prompt_env_var}" --model {self.model} --max-turns 0 --json']

    def container_config(self, prompt: str, workspace: str) -> ContainerConfig:
        shizuha_src = Path(os.path.expanduser("~")) / "work" / "shizuha-stack" / "shizuha"
        codex_accounts = _read_codex_accounts()
        return ContainerConfig(
            mounts=[
                (str(shizuha_src), "/opt/shizuha", "ro"),
                (workspace, "/workspace", "rw"),
            ],
            env={
                "NO_COLOR": "1", "HOME": "/home/bench",
                "PATH": "/usr/local/bin:/usr/bin:/bin:/opt/shizuha/node_modules/.bin",
                "CODEX_ACCOUNTS_JSON": codex_accounts,
                "BENCH_PROMPT": prompt,
                **_shizuha_litellm_env(),
            },
            command=[
                "bash", "-c",
                _codex_container_setup_cmd() +
                'exec node /opt/shizuha/dist/shizuha.js '
                f'exec --prompt "$BENCH_PROMPT" --cwd /workspace '
                f'--model {self.model} --mode autonomous --max-turns 0 --json',
            ],
        )

    def supports_visual_battle(self) -> bool:
        return True

    def visual_container_config(
        self, prompt: str, workspace: str, server_hostname: str = "chess-server",
    ) -> ContainerConfig:
        shizuha_src = Path(os.path.expanduser("~")) / "work" / "shizuha-stack" / "shizuha"
        codex_accounts = _read_codex_accounts()
        return ContainerConfig(
            mounts=[
                (str(shizuha_src), "/opt/shizuha", "ro"),
                (workspace, "/workspace", "rw"),
            ],
            env={
                "NO_COLOR": "1", "HOME": "/home/bench",
                "PATH": "/usr/local/bin:/usr/bin:/bin:/opt/shizuha/node_modules/.bin",
                "CODEX_ACCOUNTS_JSON": codex_accounts,
                "BENCH_PROMPT": prompt,
                **_shizuha_litellm_env(),
            },
            command=[
                "bash", "-c",
                _codex_container_setup_cmd() +
                'exec node /opt/shizuha/dist/shizuha.js '
                f'exec --prompt "$BENCH_PROMPT" --cwd /workspace '
                f'--model {self.model} --mode autonomous --max-turns 0 --json',
            ],
        )


class Codex51MaxAgent(AgentConfig):
    """Native Codex CLI using gpt-5.1-codex-max (higher reasoning, free plan).
    NO host credentials mounted."""
    def __init__(self):
        super().__init__(
            name="codex-51max",
            model="gpt-5.1-codex-max",
            binary="codex",
        )

    def move_command(self, prompt_env_var: str = "MOVE_PROMPT") -> list[str]:
        return ["bash", "-c",
                f'codex exec "${prompt_env_var}" --model {self.model} '
                f'--skip-git-repo-check --json']

    def container_config(self, prompt: str, workspace: str) -> ContainerConfig:
        codex_accounts = _read_codex_accounts()
        return ContainerConfig(
            mounts=[
                # Codex CLI installed globally in container image (no host binary mount)
                (workspace, "/workspace", "rw"),
            ],
            env={
                "NO_COLOR": "1", "HOME": "/home/bench",
                "PATH": "/usr/local/bin:/usr/bin:/bin",
                "CODEX_ACCOUNTS_JSON": codex_accounts,
                "BENCH_PROMPT": prompt,
            },
            command=[
                "bash", "-c",
                _codex_container_setup_cmd() +
                _codex_litellm_config_toml_cmd() +
                'exec ' + _codex_exec_with_rotation_cmd(self.model),
            ],
        )

    def supports_visual_battle(self) -> bool:
        return True

    def visual_container_config(
        self, prompt: str, workspace: str, server_hostname: str = "chess-server",
    ) -> ContainerConfig:
        codex_accounts = _read_codex_accounts()
        return ContainerConfig(
            mounts=[
                (workspace, "/workspace", "rw"),
            ],
            env={
                "NO_COLOR": "1", "HOME": "/home/bench",
                "PATH": "/usr/local/bin:/usr/bin:/bin",
                "CODEX_ACCOUNTS_JSON": codex_accounts,
                "BENCH_PROMPT": prompt,
            },
            command=[
                "bash", "-c",
                _codex_container_setup_cmd() +
                _codex_litellm_config_toml_cmd() +
                'cd /workspace && git init -q && '
                'exec ' + _codex_exec_with_rotation_cmd(self.model),
            ],
        )


class CodexXHighAgent(AgentConfig):
    """Native Codex CLI using gpt-5.3-codex with xhigh reasoning.
    NO host credentials mounted — codex auth passed via env var."""
    def __init__(self):
        super().__init__(
            name="codex-xhigh",
            model="gpt-5.3-codex",
            binary="codex",
        )

    def move_command(self, prompt_env_var: str = "MOVE_PROMPT") -> list[str]:
        return ["bash", "-c",
                f'codex exec "${prompt_env_var}" --model {self.model} '
                f'--skip-git-repo-check --json']

    def container_config(self, prompt: str, workspace: str) -> ContainerConfig:
        codex_accounts = _read_codex_accounts()
        return ContainerConfig(
            mounts=[
                (workspace, "/workspace", "rw"),
            ],
            env={
                "NO_COLOR": "1", "HOME": "/home/bench",
                "PATH": "/usr/local/bin:/usr/bin:/bin",
                "CODEX_ACCOUNTS_JSON": codex_accounts,
                "BENCH_PROMPT": prompt,
            },
            command=[
                "bash", "-c",
                _codex_container_setup_cmd() +
                _codex_reasoning_effort_cmd("xhigh") +
                _codex_litellm_config_toml_cmd() +
                'exec ' + _codex_exec_with_rotation_cmd(self.model),
            ],
        )

    def supports_visual_battle(self) -> bool:
        return True

    def visual_container_config(
        self, prompt: str, workspace: str, server_hostname: str = "chess-server",
    ) -> ContainerConfig:
        codex_accounts = _read_codex_accounts()
        return ContainerConfig(
            mounts=[
                (workspace, "/workspace", "rw"),
            ],
            env={
                "NO_COLOR": "1", "HOME": "/home/bench",
                "PATH": "/usr/local/bin:/usr/bin:/bin",
                "CODEX_ACCOUNTS_JSON": codex_accounts,
                "BENCH_PROMPT": prompt,
            },
            command=[
                "bash", "-c",
                _codex_container_setup_cmd() +
                _codex_reasoning_effort_cmd("xhigh") +
                _codex_litellm_config_toml_cmd() +
                'cd /workspace && git init -q && '
                'exec ' + _codex_exec_with_rotation_cmd(self.model),
            ],
        )


class CodexGPT54XHighThinkingAgent(CodexXHighAgent):
    """Native Codex CLI using gpt-5.4 with xhigh reasoning enabled."""
    def __init__(self):
        super().__init__()
        self.name = "codex-gpt-5.4-xhigh-thinking"
        self.model = "gpt-5.4"


class CodexGPT54XHighAgent(CodexGPT54XHighThinkingAgent):
    """Legacy alias for the gpt-5.4 xhigh thinking Codex agent."""
    def __init__(self):
        super().__init__()
        self.name = "codex-gpt-5.4-xhigh"


class CodexSparkXHighAgent(AgentConfig):
    """Native Codex CLI using gpt-5.3-codex-spark with xhigh reasoning.
    NO host credentials mounted — codex auth passed via env var."""
    def __init__(self):
        super().__init__(
            name="codex-spark-xhigh",
            model="gpt-5.3-codex-spark",
            binary="codex",
        )

    def move_command(self, prompt_env_var: str = "MOVE_PROMPT") -> list[str]:
        return ["bash", "-c",
                f'codex exec "${prompt_env_var}" --model {self.model} '
                f'--skip-git-repo-check --json']

    def container_config(self, prompt: str, workspace: str) -> ContainerConfig:
        codex_accounts = _read_codex_accounts()
        return ContainerConfig(
            mounts=[
                (workspace, "/workspace", "rw"),
            ],
            env={
                "NO_COLOR": "1", "HOME": "/home/bench",
                "PATH": "/usr/local/bin:/usr/bin:/bin",
                "CODEX_ACCOUNTS_JSON": codex_accounts,
                "BENCH_PROMPT": prompt,
            },
            command=[
                "bash", "-c",
                _codex_container_setup_cmd() +
                _codex_reasoning_effort_cmd("xhigh") +
                _codex_litellm_config_toml_cmd() +
                'exec ' + _codex_exec_with_rotation_cmd(self.model),
            ],
        )

    def supports_visual_battle(self) -> bool:
        return True

    def visual_container_config(
        self, prompt: str, workspace: str, server_hostname: str = "chess-server",
    ) -> ContainerConfig:
        codex_accounts = _read_codex_accounts()
        return ContainerConfig(
            mounts=[
                (workspace, "/workspace", "rw"),
            ],
            env={
                "NO_COLOR": "1", "HOME": "/home/bench",
                "PATH": "/usr/local/bin:/usr/bin:/bin",
                "CODEX_ACCOUNTS_JSON": codex_accounts,
                "BENCH_PROMPT": prompt,
            },
            command=[
                "bash", "-c",
                _codex_container_setup_cmd() +
                _codex_reasoning_effort_cmd("xhigh") +
                _codex_litellm_config_toml_cmd() +
                'cd /workspace && git init -q && '
                'exec ' + _codex_exec_with_rotation_cmd(self.model),
            ],
        )


class _ShizuhaOllamaAgent(AgentConfig):
    """Base class for Shizuha agents using local Ollama models.
    No OAuth credentials needed — Ollama is free/local.
    Uses --add-host so Docker container can reach host Ollama."""

    def move_command(self, prompt_env_var: str = "MOVE_PROMPT") -> list[str]:
        return ["bash", "-c",
                f'node /opt/shizuha/dist/shizuha.js exec '
                f'--prompt "${prompt_env_var}" --model {self.model} --max-turns 0 --json']

    def container_config(self, prompt: str, workspace: str) -> ContainerConfig:
        shizuha_src = Path(os.path.expanduser("~")) / "work" / "shizuha-stack" / "shizuha"
        return ContainerConfig(
            mounts=[
                (str(shizuha_src), "/opt/shizuha", "ro"),
                (workspace, "/workspace", "rw"),
            ],
            env={
                "NO_COLOR": "1", "HOME": "/home/bench",
                "PATH": "/usr/local/bin:/usr/bin:/bin:/opt/shizuha/node_modules/.bin",
                "OLLAMA_BASE_URL": "http://host.docker.internal:11434",
                "BENCH_PROMPT": prompt,
            },
            command=[
                "bash", "-c",
                'exec node /opt/shizuha/dist/shizuha.js '
                f'exec --prompt "$BENCH_PROMPT" --cwd /workspace '
                f'--model {self.model} --mode autonomous --max-turns 0 --json',
            ],
            extra_docker_args=["--add-host=host.docker.internal:host-gateway"],
        )


class ShizuhaQwen3CoderNextAgent(_ShizuhaOllamaAgent):
    """Shizuha + qwen3-coder-next:q4_K_M (80B total, 3B active, 256K context)."""
    def __init__(self):
        super().__init__(
            name="shizuha-qwen3-coder-next",
            model="qwen3-coder-next:q4_K_M",
            binary="shizuha",
        )


class ShizuhaQwen35Agent(_ShizuhaOllamaAgent):
    """Shizuha + qwen3.5:35b-a3b (35B MoE, 3B active, 256K context, vision+thinking)."""
    def __init__(self):
        super().__init__(
            name="shizuha-qwen3.5",
            model="qwen3.5:35b-a3b",
            binary="shizuha",
        )


# Agents disabled from benchmarks and dashboard (kept for historical results)
DISABLED_AGENTS = {
    "shizuha-51max",
    "codex-51max",
    "shizuha-xhigh",
    "shizuha-codex-spark-xhigh",
    "codex-spark-xhigh",
}

# Default jury backend for benchmark runs (can be overridden via dashboard settings)
DEFAULT_JURY_BACKEND = "codex-xhigh"

# ─── Persistent settings (dashboard-editable) ────────────────────────────
_SETTINGS_PATH = Path(__file__).resolve().parent / "settings.json"


def load_settings() -> dict:
    """Load persistent settings from settings.json."""
    try:
        if _SETTINGS_PATH.exists():
            import json
            return json.loads(_SETTINGS_PATH.read_text())
    except Exception:
        pass
    return {}


def save_settings(settings: dict):
    """Save persistent settings to settings.json."""
    import json
    _SETTINGS_PATH.write_text(json.dumps(settings, indent=2) + "\n")


def get_jury_backend() -> str:
    """Get the configured jury backend (settings.json overrides DEFAULT_JURY_BACKEND)."""
    settings = load_settings()
    backend = settings.get("jury_backend", DEFAULT_JURY_BACKEND)
    # Spark jury backend is intentionally disabled for benchmark quality control.
    if backend == "codex-spark-xhigh":
        return DEFAULT_JURY_BACKEND
    return backend


# Default execution environment for agents
DEFAULT_EXECUTION_ENVIRONMENT = "container"
VALID_EXECUTION_ENVIRONMENTS = ("container", "baremetal")


def get_execution_environment() -> str:
    """Get the configured execution environment ('container' or 'baremetal')."""
    settings = load_settings()
    env = settings.get("execution_environment", DEFAULT_EXECUTION_ENVIRONMENT)
    if env not in VALID_EXECUTION_ENVIRONMENTS:
        return DEFAULT_EXECUTION_ENVIRONMENT
    return env

# Registry of all active agents
AGENTS: dict[str, AgentConfig] = {
    "shizuha": ShizuhaAgent(),
    # "shizuha-xhigh": disabled — superseded by shizuha (gpt-5.3-codex)
    # "shizuha-51max": disabled — slower, lower pass rate than shizuha
    "shizuha-claude": ShizuhaClaudeAgent(),
    "shizuha-qwen3-coder-next": ShizuhaQwen3CoderNextAgent(),
    "shizuha-qwen3.5": ShizuhaQwen35Agent(),
    "shizuha-codex-xhigh": ShizuhaCodexXHighAgent(),
    "shizuha-gpt-5.4-xhigh": ShizuhaGPT54XHighAgent(),
    "shizuha-gpt-5.4-xhigh-thinking": ShizuhaGPT54XHighThinkingAgent(),  # alias (same agent)
    # "shizuha-codex-spark-xhigh": disabled — lower benchmark quality
    "codex": CodexAgent(),
    "codex-xhigh": CodexXHighAgent(),
    "codex-gpt-5.4-xhigh-thinking": CodexGPT54XHighThinkingAgent(),
    "codex-gpt-5.4-xhigh": CodexGPT54XHighAgent(),  # legacy alias
    # "codex-spark-xhigh": disabled — lower benchmark quality
    # "codex-51max": disabled — superseded by codex (gpt-5.3-codex)
    "claude-opus": ClaudeOpusAgent(),
}


def get_agent(name: str) -> AgentConfig:
    if name not in AGENTS:
        raise ValueError(f"Unknown agent: {name}. Available: {list(AGENTS.keys())}")
    return AGENTS[name]


def get_agent_version(agent: AgentConfig) -> str:
    """Try to get the agent's version string."""
    import subprocess
    try:
        result = subprocess.run(
            [agent.binary, "--version"],
            capture_output=True, text=True, timeout=10,
        )
        version = result.stdout.strip() or result.stderr.strip()
        return version.split("\n")[0] if version else "unknown"
    except Exception:
        return "unknown"
