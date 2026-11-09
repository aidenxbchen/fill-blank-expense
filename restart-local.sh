#!/bin/bash
set -euo pipefail
export PATH="$HOME/bin:$HOME/opt/ollama:/usr/local/bin:/opt/homebrew/bin:$PATH"
# Clash mixed-port; harmless if down for local-only use
export https_proxy="${https_proxy:-http://127.0.0.1:7897}"
export http_proxy="${http_proxy:-http://127.0.0.1:7897}"
export HTTPS_PROXY="${HTTPS_PROXY:-$https_proxy}"
export HTTP_PROXY="${HTTP_PROXY:-$http_proxy}"
ROOT="$HOME/Code/fill-blank-expense"
if [[ -f "$ROOT/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT/.env"
  set +a
fi
PY="$HOME/anaconda3/bin/python3"
OLLAMA="$HOME/opt/ollama/ollama"

# Restart only this repository's listeners; never terminate an unrelated service.
stop_owned_listener() {
  local port="$1" script="$2" pid command
  for pid in $(lsof -t -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null || true); do
    command="$(ps -p "$pid" -o args=)"
    if [[ "$command" != *"$ROOT/$script"* ]]; then
      echo "Refusing to restart port $port: listener is not $script" >&2
      exit 1
    fi
    kill "$pid"
  done
  for attempt in {1..30}; do
    if ! lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then return; fi
    sleep 0.1
  done
  echo "Port $port did not stop; no replacement started" >&2
  exit 1
}

if ! lsof -nP -iTCP:11434 -sTCP:LISTEN >/dev/null 2>&1; then
  nohup "$OLLAMA" serve > /tmp/ollama-serve.log 2>&1 &
  echo "started ollama pid=$!"; sleep 2
else
  echo "ollama already on 11434"
fi

stop_owned_listener 18790 ocr/server.py
if ! lsof -nP -iTCP:18790 -sTCP:LISTEN >/dev/null 2>&1; then
  nohup "$PY" "$ROOT/ocr/server.py" > /tmp/fill-blank-ocr.log 2>&1 &
  echo "started ocr pid=$!"; sleep 1
else
  echo "ocr already on 18790"
fi

stop_owned_listener 5173 web/serve.py
if ! lsof -nP -iTCP:5173 -sTCP:LISTEN >/dev/null 2>&1; then
  cd "$ROOT/web"
  nohup "$PY" "$ROOT/web/serve.py" --bind 127.0.0.1 --port 5173 > /tmp/fill-blank-web.log 2>&1 &
  echo "started web pid=$!"; sleep 1
else
  echo "web already on 5173"
fi

curl -sS http://127.0.0.1:18790/api/health; echo
curl -sS -o /dev/null -w "web=%{http_code}\n" http://127.0.0.1:5173/

# Public tunnel: https://baoxiao.xbchen.top via appointment tunnel (LaunchAgent)
# Config: ~/.cloudflared/config.yml  (/api → :18790, else → :5173; xbchen.top → :5001)
# Managed by: ~/Library/LaunchAgents/com.xbchen.cloudflared.plist
# Restart tunnel (preferred):
#   launchctl kickstart -k gui/$(id -u)/com.xbchen.cloudflared
# Or:
#   launchctl bootout gui/$(id -u)/com.xbchen.cloudflared
#   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.xbchen.cloudflared.plist
