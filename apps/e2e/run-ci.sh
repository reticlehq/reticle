#!/usr/bin/env bash
# Boot api + demo + next-smoke, wait for health, run the e2e battery, tear down.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

# Provision the bridge pairing token BEFORE the dev servers boot. next-smoke's withReticle reads it at
# `next dev` config load (before any per-spec bridge exists) to inline into its client connect; the
# per-spec bridges (start()) read the same file. Mirrors the real daemon-first workflow.
TOKEN_DIR="${RETICLE_PAIRING_TOKEN_DIR:-$HOME/.reticle}"
TOKEN_FILE="$TOKEN_DIR/pairing-token"
if [ ! -s "$TOKEN_FILE" ]; then
  mkdir -p "$TOKEN_DIR" && chmod 700 "$TOKEN_DIR"
  head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$TOKEN_FILE"
  chmod 600 "$TOKEN_FILE"
fi

echo "==> starting api (:8787), demo (:4310), next-smoke (:3100)"
REFLECT_MS=6000 node apps/api/server.mjs > /tmp/e2e-api.log 2>&1 &
API=$!
pnpm --filter @reticlehq/demo dev > /tmp/e2e-demo.log 2>&1 &
DEMO=$!
pnpm --filter @reticlehq/next-smoke dev > /tmp/e2e-next.log 2>&1 &
NEXT=$!
cleanup() { kill "$API" "$DEMO" "$NEXT" 2>/dev/null || true; }
trap cleanup EXIT

echo "==> waiting for servers"
for _ in $(seq 1 120); do
  curl -s -o /dev/null http://localhost:8787/api/health \
    && curl -s -o /dev/null http://localhost:4310 \
    && curl -s -o /dev/null http://localhost:3100 \
    && break
  sleep 2
done
curl -s -o /dev/null http://localhost:8787/api/health || { echo "api never came up"; cat /tmp/e2e-api.log; exit 1; }
curl -s -o /dev/null http://localhost:4310 || { echo "demo never came up"; cat /tmp/e2e-demo.log; exit 1; }
curl -s -o /dev/null http://localhost:3100 || { echo "next never came up"; cat /tmp/e2e-next.log; exit 1; }

echo "==> running e2e battery"
node apps/e2e/run.mjs
