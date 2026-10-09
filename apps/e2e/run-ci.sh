#!/usr/bin/env bash
# Boot api + bench-app (the dashboard fixture) + next-smoke, wait for health, run the e2e battery, tear
# down. The dashboard specs (real-world-tests, multi-agent-lease) drive @reticlehq/bench-app on :4310 —
# it carries the login + deployments/compose/diagnostics surface those specs exercise. bench-app dials
# the per-spec bridge via RETICLE_PORT and presents the pairing token via VITE_RETICLE_TOKEN.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

# Batteries are not watched, and a shown browser changes their timing: hide every browser Reticle opens.
export RETICLE_HEADLESS=1

# The battery is not a user — keep its daemons/tool calls out of the adoption metrics.
export RETICLE_TELEMETRY=0
# And say so on every event that does get emitted. `CI` is the only signal an event has for
# "this was a pipeline", it is set by the runner and by nothing else, so a battery driven from a
# laptop or a cloud agent sandbox reported itself as a person at a machine.
# `${CI:-true}`, not `CI=1`. GitHub Actions already sets `CI=true`, and overwriting it with
# `1` broke `tauri build`, whose CLI reads CI as the value of its own `--ci` flag and rejects
# a non-boolean: `error: invalid value '1' for '--ci'`. That turned the desktop gate red on
# main for a reason whose own error message blamed missing webkit packages the log showed
# being installed. Only set it when the runner has not, which was always the intent: the case
# this exists for is a battery driven from a laptop or a cloud agent sandbox.
export CI="${CI:-true}"

# Provision the bridge pairing token BEFORE the dev servers boot. next-smoke's withReticle reads it at
# `next dev` config load (before any per-spec bridge exists) to inline into its client connect; the
# per-spec bridges (start()) read the same file. Mirrors the real daemon-first workflow.
# Test state and pairing are private, so existing clients cannot join the test bridge.
export RETICLE_PORT="${RETICLE_PORT:-14400}"
export RETICLE_TEST_STATE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/reticle-web-e2e.XXXXXX")"
export RETICLE_STATE_DIR="$RETICLE_TEST_STATE_DIR"
export RETICLE_PAIRING_TOKEN_DIR="$RETICLE_TEST_STATE_DIR"

TOKEN_DIR="${RETICLE_PAIRING_TOKEN_DIR:-$HOME/.reticle}"
TOKEN_FILE="$TOKEN_DIR/pairing-token"
if [ ! -s "$TOKEN_FILE" ]; then
  mkdir -p "$TOKEN_DIR" && chmod 700 "$TOKEN_DIR"
  head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$TOKEN_FILE"
  chmod 600 "$TOKEN_FILE"
fi

# Build first, because the battery drives `dist` and nothing else here does.
#
# CI builds in the job before this script runs, so it was never wrong there. A developer typing
# `pnpm test:e2e` got whatever `dist` happened to be on disk — which means a green battery can be
# green about code that is not the code in the working tree, and a red one can be red about a bug
# already fixed. Both happened while fixing the contract-skew defect: 22 of 39 specs failed against
# a daemon compiled before the fix, and `core/dist` did not contain the new constant at all.
#
# Turbo makes this nearly free when nothing changed, and the alternative is a class of run that
# cannot be trusted either way.
echo "==> building (the battery runs against dist)"
pnpm build > /dev/null || { echo "build failed — the battery would run against a stale dist"; exit 1; }

# Refuse occupied ports; cleanup is limited to processes this run starts.
E2E_PORTS="8787 4310 3100 $RETICLE_PORT"

# Wait for the ports to be FREE before binding them.
#
# Cleanup stops the recorded child processes, but a stopped process does not release its port the instant
# the shell returns: back-to-back battery runs raced the previous run's teardown and died on
# `EADDRINUSE :::8787` during boot — a whole 8-minute run lost to the run before it, reported as an
# api that "died during boot". Twice in one afternoon, on a green tree. Polling here is the fix
# because the failure is timing, not state: nothing needs killing, only waiting for.
echo "==> waiting for the battery's ports to be free"
for port in $E2E_PORTS; do
  for _ in $(seq 1 30); do
    lsof -nP -iTCP:"$port" -sTCP:LISTEN -t > /dev/null 2>&1 || break
    sleep 1
  done
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN -t > /dev/null 2>&1; then
    echo "port $port is still held after 30s by:"
    lsof -nP -iTCP:"$port" -sTCP:LISTEN
    echo "the battery would run against another process's app — refusing to start."
    exit 1
  fi
done

echo "==> starting api (:8787), bench-app (:4310), next-smoke (:3100)"
REFLECT_MS=6000 node apps/api/server.mjs > /tmp/e2e-api.log 2>&1 &
API=$!
# bench-app on :4310, dialing RETICLE_PORT and presenting this run's pairing token.
VITE_RETICLE_TOKEN="$(cat "$TOKEN_FILE")" \
  pnpm --filter @reticlehq/bench-app exec vite --port 4310 --strictPort > /tmp/e2e-demo.log 2>&1 &
DEMO=$!
pnpm --filter @reticlehq/next-smoke dev > /tmp/e2e-next.log 2>&1 &
NEXT=$!
cleanup() {
  node --input-type=module - "$API" "$DEMO" "$NEXT" <<'NODE'
import { stopProcessTree } from './apps/e2e/gate-harness.mjs';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
const state = process.env.RETICLE_TEST_STATE_DIR;
for (const file of readdirSync(state)) {
  if (/^daemon-\d+\.pid$/.test(file)) {
    stopProcessTree(Number(readFileSync(join(state, file), 'utf8')));
  }
}
for (const pid of process.argv.slice(2)) stopProcessTree(Number(pid));
NODE
}
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
curl -s -o /dev/null http://localhost:4310 || { echo "bench-app never came up"; cat /tmp/e2e-demo.log; exit 1; }
curl -s -o /dev/null http://localhost:3100 || { echo "next never came up"; cat /tmp/e2e-next.log; exit 1; }

# A port that ANSWERS is not the same as OUR app answering. `next dev` exits instantly with
# EADDRINUSE when something else already holds :3100, and the curl above then happily succeeds
# against that stranger — so the whole battery drove somebody else's app. Measured: every next-smoke
# spec failed with "no connected session with id 'next-smoke'" (that app connects with a per-tab id),
# which reads exactly like a product defect and is not one. The servers we started must still be
# ALIVE; if one is not, say which, and say why.
for pair in "$API:api:/tmp/e2e-api.log" "$DEMO:bench-app:/tmp/e2e-demo.log" "$NEXT:next-smoke:/tmp/e2e-next.log"; do
  pid="${pair%%:*}"; rest="${pair#*:}"; name="${rest%%:*}"; log="${rest#*:}"
  kill -0 "$pid" 2>/dev/null && continue
  echo "==> $name died during boot — the battery would run against whatever else holds its port:"
  cat "$log"
  exit 1
done

echo "==> running e2e battery"
node apps/e2e/run.mjs
BATTERY_STATUS=$?

# The soak runs HERE because this is the only place a real app is already up and paired. It answers
# the question the battery cannot: not "does a tool work" but "how often does it fail", which needs
# repetition and idle time rather than one call. Modest numbers — this is the merge-gate sample, and
# `pnpm gate:soak:record` is the longer run that re-records the baseline before a release.
# Once per battery, not once per shard: only the first shard (or an unsharded run) soaks.
SOAK_STATUS=0
case "${E2E_SHARD:-}" in
  ''|1/*)
    echo "==> soak + tool profile"
    node apps/e2e/soak.mjs --rounds "${SOAK_ROUNDS:-10}" --idle-ms "${SOAK_IDLE_MS:-1000}"
    SOAK_STATUS=$?
    ;;
esac

# Report the battery's verdict first when both fail: it covers far more ground, so it is the more
# useful thing to read. Neither is allowed to mask the other.
if [ "$BATTERY_STATUS" -ne 0 ]; then exit "$BATTERY_STATUS"; fi
exit "$SOAK_STATUS"
