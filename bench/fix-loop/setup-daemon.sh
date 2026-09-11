#!/usr/bin/env bash
# Clean environment for the WITH-Reticle cost-delta run. See COST-DELTA.md "Reproduce".
#
#   bash setup-daemon.sh <port>              free the port + boot the bench-app pointed at it
#   bash setup-daemon.sh --teardown <port>   kill the local daemon + bench-app on that port
#
# It deliberately does NOT start the daemon itself — the Reticle MCP proxy must spawn the LOCAL daemon on
# a CLEAN port when Claude Code (re)starts, so the proxy owns it. This script only guarantees the port is
# free of stale daemons and that the bench-app is up and configured for that port.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

free_port() {
  local port="$1"
  local pids
  pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  if [ -n "$pids" ]; then echo "killing daemon(s) on :$port -> $pids"; kill $pids 2>/dev/null || true; sleep 1; fi
  # also sweep any local serve/mcp daemons for this port
  pkill -f "cli.js (serve|mcp).*$port" 2>/dev/null || true
  sleep 1
  if lsof -tiTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "WARN: :$port still in use — resolve before restarting Claude Code"; else echo ":$port is free"; fi
}

if [ "${1:-}" = "--teardown" ]; then
  PORT="${2:?usage: setup-daemon.sh --teardown <port>}"
  free_port "$PORT"
  pkill -f "bench-app.*vite" 2>/dev/null || true
  echo "teardown done. Restore .mcp.json RETICLE_PORT and restart Claude Code."
  exit 0
fi

PORT="${1:?usage: setup-daemon.sh <port>}"
TOKEN_FILE="$HOME/.reticle/pairing-token"
[ -f "$TOKEN_FILE" ] || { echo "no pairing token at $TOKEN_FILE — start any reticle daemon once to mint it"; exit 1; }

echo "== 1. build (dist must be v2.2.0) =="
pnpm -r --filter "@reticlehq/*" build >/dev/null

echo "== 2. free the MCP port so the proxy spawns a FRESH local daemon on it =="
free_port "$PORT"

echo "== 3. boot the bench-app pointed at :$PORT with the v2.2.0 SDK =="
pkill -f "bench-app.*vite" 2>/dev/null || true; sleep 1
( cd apps/bench-app && RETICLE_PORT="$PORT" VITE_RETICLE_TOKEN="$(cat "$TOKEN_FILE")" \
    nohup pnpm dev >/tmp/bench-cost-delta.log 2>&1 & )
sleep 6
grep -iE "Local:" /tmp/bench-cost-delta.log | head -1 || echo "bench-app log: /tmp/bench-cost-delta.log"

cat <<EOF

NEXT (must be done by you — cannot be scripted):
  1. Ensure .mcp.json mcpServers.reticle env RETICLE_PORT = $PORT  (and args use packages/server/dist/cli.js)
  2. Restart Claude Code so its reticle proxy spawns the LOCAL daemon on the now-free :$PORT
  3. Verify: reticle_tools has NO version_info/apply_update/rollback; reticle_sessions shows localhost:4313
  4. Run the WITH-Reticle cells and compare to the v2.1.0 baseline in COST-DELTA.md
EOF
