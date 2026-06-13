#!/usr/bin/env bash
# Boot api + demo + next-smoke, wait for health, run the e2e battery, tear down.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

echo "==> starting api (:8787), demo (:3000), next-smoke (:3100)"
REFLECT_MS=6000 node apps/api/server.mjs > /tmp/e2e-api.log 2>&1 &
API=$!
pnpm --filter @syrin/iris-demo dev > /tmp/e2e-demo.log 2>&1 &
DEMO=$!
pnpm --filter @syrin/iris-next-smoke dev > /tmp/e2e-next.log 2>&1 &
NEXT=$!
cleanup() { kill "$API" "$DEMO" "$NEXT" 2>/dev/null || true; }
trap cleanup EXIT

echo "==> waiting for servers"
for _ in $(seq 1 120); do
  curl -s -o /dev/null http://localhost:8787/api/health \
    && curl -s -o /dev/null http://localhost:3000 \
    && curl -s -o /dev/null http://localhost:3100 \
    && break
  sleep 2
done
curl -s -o /dev/null http://localhost:8787/api/health || { echo "api never came up"; cat /tmp/e2e-api.log; exit 1; }
curl -s -o /dev/null http://localhost:3100 || { echo "next never came up"; cat /tmp/e2e-next.log; exit 1; }

echo "==> running e2e battery"
node apps/e2e/run.mjs
