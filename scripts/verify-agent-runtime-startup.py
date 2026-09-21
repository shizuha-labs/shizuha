#!/usr/bin/env python3
"""Exercise the candidate's baked env entrypoint without credentials or inference.

Version checks missed the 2026-09-08 Hive launch failure: a document was passed
to the intentionally strict single-line --context-prompt option. Run the real
gateway, verify its private document transport and persisted system prefix,
then stop only this fixture. This proves initialization, not platform auth or
agent productivity. The enclosing smoke Job supplies no credentials/SA volume.
"""
from __future__ import annotations

import argparse
import fcntl
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import signal
import socket
import sqlite3
import stat
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request


ENTRYPOINT = Path('/usr/local/bin/agent-runtime-entrypoint.sh')
BUNDLE = Path('/opt/shizuha/dist/shizuha.js')
DOCUMENT = ('Synthetic runtime document: 日本語\n'
            'Literal $variables, $(commands), `ticks`, "quotes", tabs\tand trailing lines.\n\n') * 160


def require(condition: bool, diagnostic: str) -> None:
    if not condition:
        raise RuntimeError(diagnostic)


class ModelSink:
    """Permit local metadata discovery; reject and count every other request."""

    def __init__(self) -> None:
        self.metadata_requests = 0
        self.rejected_requests = 0
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def respond(self, status_code, body):
                payload = json.dumps(body).encode()
                self.send_response(status_code)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(payload)))
                self.send_header('Connection', 'close')
                self.end_headers()
                self.wfile.write(payload)

            def do_GET(self):
                if self.path.rstrip('/') in ('/models', '/v1/models'):
                    owner.metadata_requests += 1
                    self.respond(200, {'object': 'list', 'data': [{
                        'id': 'GLM-5.3-Flash', 'object': 'model', 'max_model_len': 131072,
                    }]})
                else:
                    self.reject()

            def reject(self):
                # Never read/log a request body or authorization headers.
                owner.rejected_requests += 1
                self.respond(503, {'error': 'Inference and external auth are forbidden in startup smoke'})

            do_POST = do_PUT = do_PATCH = do_DELETE = do_HEAD = do_OPTIONS = reject

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.url = f'http://127.0.0.1:{self.server.server_port}'

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *_):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)


def unused_port() -> int:
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        return listener.getsockname()[1]


def fixture_environment(home: Path, sink_url: str, port: int) -> dict[str, str]:
    # Deliberately do not copy os.environ: no platform, broker, provider, proxy,
    # channel or credential settings can leak from the CI runner into the seat.
    return {
        'PATH': '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
        'LANG': 'C.UTF-8', 'SHELL': '/bin/bash',
        'HOME': str(home), 'TMPDIR': str(home / 'tmp'),
        'XDG_CONFIG_HOME': str(home / '.config'),
        'AGENT_ID': '00000000-0000-4000-8000-000000000001',
        'AGENT_USERNAME': 'runtime-startup-fixture',
        'MODEL': 'cortex/GLM-5.3-Flash',
        'SHIZUHA_K8S_PRIMARY_METHOD': 'shizuha',
        'CONTEXT_PROMPT': DOCUMENT, 'PORT': str(port),
        'SHIZUHA_METRICS_PORT': '0',
        'SHIZUHA_IDLE_HEARTBEAT_DISABLED': '1',
        'SHIZUHA_PREWARM_ENABLE': '0',
        'SHIZUHA_DISABLE_MCP_JSON': '1',
        'SHIZUHA_AUTO_UPDATE': '0',
        'CORTEX_BASE_URL': sink_url,
        'VLLM_BASE_URL': sink_url,
        'OPENAI_BASE_URL': sink_url + '/v1',
        'VLLM_FALLBACK_BASE_URLS': '',
        'SHIZUHA_PACKAGE_CACHE_HOST': '127.0.0.1',
    }


def stop_fixture(process: subprocess.Popen) -> None:
    if process.poll() is None:
        # start_new_session gives only this fixture its own process group.
        os.killpg(process.pid, signal.SIGTERM)
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=5)


def inspect_transport(pid: int, home: Path, bundle: Path) -> dict:
    args = Path(f'/proc/{pid}/cmdline').read_bytes().split(b'\0')
    require(str(bundle).encode() in args and b'gateway' in args,
            'baked entrypoint did not exec the real gateway bundle')
    require(b'--context-prompt-file' in args and b'--context-prompt' not in args
            and DOCUMENT.encode() not in args, 'context document leaked into inline argv')
    prompt_file = Path(os.fsdecode(args[args.index(b'--context-prompt-file') + 1]))
    require(prompt_file.resolve().is_relative_to(home / 'tmp'), 'context file escaped private fixture directory')
    require(stat.S_ISREG(prompt_file.lstat().st_mode), 'context file is not regular')
    file_mode = stat.S_IMODE(prompt_file.stat().st_mode)
    parent_mode = stat.S_IMODE(prompt_file.parent.stat().st_mode)
    require(file_mode == 0o600 and parent_mode == 0o700, 'context file/directory permissions are not private')
    payload = prompt_file.read_bytes()
    require(payload == DOCUMENT.encode(), 'context file differs from the environment document')
    require(Path(f'/proc/{pid}/cwd').resolve() == home, 'gateway did not use private fixture working directory')
    return {'document_bytes': len(payload), 'document_sha256': hashlib.sha256(payload).hexdigest(),
            'file_mode': oct(file_mode), 'directory_mode': oct(parent_mode)}


def inspect_state(home: Path) -> dict:
    with sqlite3.connect((home / '.shizuha-state.db').as_uri() + '?mode=ro', uri=True) as db:
        prefixes = db.execute('SELECT system_prompt FROM session_provider_prefix_heads').fetchall()
        require(len(prefixes) == 1 and prefixes[0][0].count(DOCUMENT) == 1,
                'persisted system prefix did not contain the exact complete document once')
        counts = {table: db.execute(f'SELECT count(*) FROM {table}').fetchone()[0]
                  for table in ('messages', 'session_wire_prefix')}
        require(all(value == 0 for value in counts.values()), 'startup produced messages or a model wire prefix')
    return {'exact_document_in_system_prefix': True, **counts}


def verify_cache_lock(helper: Path = Path('/usr/bin/flock')) -> dict:
    """Exercise the actual util-linux dependency on each native candidate."""
    require(helper.is_file() and os.access(helper, os.X_OK), 'runtime cache lock helper is missing')
    with tempfile.TemporaryDirectory(prefix='agent-cache-lock-smoke-') as directory:
        owner = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        contender = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            try:
                subprocess.run([str(helper), '--exclusive', '--nonblock', str(owner)],
                               pass_fds=(owner,), check=True, timeout=5,
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                try:
                    fcntl.flock(contender, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError:
                    pass
                else:
                    raise RuntimeError('runtime cache helper did not retain the inherited directory lock')
            finally:
                os.close(owner)
            fcntl.flock(contender, fcntl.LOCK_EX | fcntl.LOCK_NB)
        finally:
            os.close(contender)
    return {'cache_lock_helper': str(helper), 'cache_lock_verified': True}


def verify_startup(entrypoint: Path = ENTRYPOINT, bundle: Path = BUNDLE,
                   timeout_seconds: float = 60, expected_entrypoint_sha256: str | None = None) -> dict:
    require(os.getuid() != 0, 'startup smoke must run as the unprivileged image user')
    cache_lock = verify_cache_lock()
    # Fail closed if a candidate ever starts carrying global configuration or
    # if the enclosing Job starts mounting real platform credentials.
    for forbidden in ('/etc/shizuha/config.toml', '/run/secrets/kubernetes.io/serviceaccount/token',
                      '/var/run/secrets/kubernetes.io/serviceaccount/token',
                      '/run/shizuha/mcp-auth-proxy/proxy.sock'):
        require(not Path(forbidden).exists(), f'credential/config mount forbidden in startup smoke: {forbidden}')
    # resolveAgentWorkspaceCwd prefers this fixed Hive PVC path when present,
    # even with a different HOME/cwd. The Job masks baked home contents with a
    # fresh emptyDir (local controls use tmpfs), so the fixture owns all state.
    require(not Path('/home/agent/.shizuha').exists(),
            'startup smoke requires a fresh /home/agent volume without a Hive workspace')
    entrypoint_sha = hashlib.sha256(entrypoint.read_bytes()).hexdigest()
    if expected_entrypoint_sha256:
        require(entrypoint_sha == expected_entrypoint_sha256, 'candidate entrypoint differs from build source')
    with tempfile.TemporaryDirectory(prefix='agent-runtime-startup-') as directory, ModelSink() as sink:
        home = Path(directory)
        (home / 'tmp').mkdir(mode=0o700)
        env = fixture_environment(home, sink.url, unused_port())
        log = home / 'gateway.log'
        with log.open('wb') as output:
            os.chmod(log, 0o600)
            # No argv: exercise the baked environment-driven launcher unchanged.
            process = subprocess.Popen([str(entrypoint)], cwd=home, env=env,
                                       stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
            try:
                deadline = time.monotonic() + timeout_seconds
                initialized = False
                opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
                while time.monotonic() < deadline:
                    if process.poll() is not None:
                        raise RuntimeError(f'gateway exited before initialization (exit {process.returncode}): '
                                           + log.read_text(errors='replace')[-2000:])
                    try:
                        with opener.open(f"http://127.0.0.1:{env['PORT']}/health", timeout=0.5) as response:
                            initialized = response.status == 200 and json.load(response).get('initialized') is True
                    except (OSError, ValueError, urllib.error.URLError):
                        pass
                    if initialized:
                        break
                    time.sleep(0.1)
                require(initialized, 'gateway did not initialize before startup deadline')
                transport = inspect_transport(process.pid, home, bundle)
                inspect_state(home)
            finally:
                stop_fixture(process)
        # Check after shutdown as well, so background work cannot race the receipt.
        state = inspect_state(home)
        require(sink.rejected_requests == 0, 'startup attempted inference or unexpected external/auth traffic')
        logs = log.read_text(errors='replace')
        require('Idle-heartbeat armed' not in logs and 'Pre-warming Cortex prefix cache' not in logs,
                'startup enabled idle heartbeat or prefix prewarm')
        return {'initialized': True, 'entrypoint_sha256': entrypoint_sha, **cache_lock, **transport, **state,
                'metadata_requests': sink.metadata_requests, 'model_requests': 0,
                'fixture_stopped': process.poll() is not None}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--entrypoint-sha256')
    args = parser.parse_args()
    try:
        receipt = verify_startup(expected_entrypoint_sha256=args.entrypoint_sha256)
    except Exception as error:
        print(json.dumps({'startup_smoke_passed': False, 'error': str(error)}), flush=True)
        return 1
    print(json.dumps({'startup_smoke_passed': True, **receipt}), flush=True)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
