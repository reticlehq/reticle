#!/usr/bin/env bash
# Build what the desktop battery needs, then run it.
#
# Nothing to boot here — each desktop spec starts its own runtime and waits for it to DIAL the
# bridge, which is the direction that makes a desktop app a desktop app. What this script does
# provide is the two things a spec cannot conjure: a pairing token, and a PACKAGED Tauri binary
# (Tauri embeds its frontend at COMPILE time, so the Rust build has to follow the Vite build — get
# that order wrong and the app boots to a blank window with no error anywhere).
#
# On Linux, run this under `xvfb-run -a`: both runtimes need a display to create a window at all,
# even one that is never shown.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

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

TOKEN_DIR="${RETICLE_PAIRING_TOKEN_DIR:-$HOME/.reticle}"
TOKEN_FILE="$TOKEN_DIR/pairing-token"
if [ ! -s "$TOKEN_FILE" ]; then
  mkdir -p "$TOKEN_DIR" && chmod 700 "$TOKEN_DIR"
  head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$TOKEN_FILE"
  chmod 600 "$TOKEN_FILE"
fi
export RETICLE_PORT=4400
export VITE_RETICLE_TOKEN="$(cat "$TOKEN_FILE")"

echo "==> building the packaged Tauri smoke app (vite build, then cargo — that order matters)"
pnpm --filter @reticlehq/tauri-smoke exec tauri build --no-bundle || {
  # Report the FAILURE, then the usual causes, in that order and clearly separated.
  #
  # This used to assert one cause: "it needs a Rust toolchain, and on Linux webkit2gtk-4.1 +
  # libsoup-3 dev packages". The gate then went red for an entirely different reason (a CI=1 that
  # the tauri CLI reads as the value of its own --ci flag and rejects), and the message sent the
  # reader to check webkit packages that the log, thirty lines earlier, showed being installed.
  # Same rule as everywhere else in this repo: a probe reports what it observed, and offers a cause
  # as a possibility rather than a finding.
  echo "tauri build failed (exit above). Read the tauri error itself first, it is printed above this line."
  echo "  Usual causes, if the error does not say: no Rust toolchain; on Linux, missing webkit2gtk-4.1"
  echo "  or libsoup-3 dev packages; or an env var the tauri CLI parses as one of its own flags."
  exit 1
}

echo "==> running desktop battery"
node apps/e2e/run.mjs --desktop
