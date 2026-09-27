#!/usr/bin/env bash
# Browser gate for a standalone, GitHub-Actions-independent SPOOL qualification.
set -Eeuo pipefail
umask 077

fail() { printf 'SPOOL_BROWSER_GATE: %s\n' "$*" >&2; exit 2; }
[[ $# -eq 1 ]] || fail 'usage: browser-smoke-direct.sh ABSOLUTE_EVIDENCE_SCREENSHOT_PATH'
[[ "$1" = /* ]] || fail 'screenshot path must be absolute'
[[ -f dist/index.html ]] || fail 'built dist/index.html is missing'
command -v python3 >/dev/null || fail 'python3 is required'
python3 -c 'import websocket' >/dev/null 2>&1 || fail 'python websocket-client must be installed'

# Reserve an ephemeral local port rather than trusting an unrelated server on
# a hard-coded port. Never publish the test HTTP endpoint externally.
port=$(python3 - <<'PY'
import socket
s = socket.socket()
s.bind(('127.0.0.1', 0))
print(s.getsockname()[1])
s.close()
PY
)
python3 scripts/spa-server.py --port "$port" --directory "$PWD/dist" >/dev/null 2>&1 &
server_pid=$!
cleanup() { kill "$server_pid" 2>/dev/null || true; wait "$server_pid" 2>/dev/null || true; }
trap cleanup EXIT
ready=0
for _ in {1..40}; do
  kill -0 "$server_pid" 2>/dev/null || fail 'SPA server terminated before readiness'
  if python3 - "$port" <<'PY' >/dev/null 2>&1
import sys, urllib.request
with urllib.request.urlopen('http://127.0.0.1:' + sys.argv[1] + '/studio/new', timeout=2) as r:
    body = r.read(4096)
    assert r.status == 200 and b'id="app-root"' in body
PY
  then ready=1; break; fi
  sleep 0.1
done
[[ "$ready" == 1 ]] || fail 'SPA server did not serve the expected SPOOL shell'
SPOOL_URL="http://127.0.0.1:$port" SPOOL_SCREENSHOT_PATH="$1" python3 scripts/browser-smoke.py
[[ -s "$1" ]] || fail 'browser did not write a nonempty evidence screenshot'
