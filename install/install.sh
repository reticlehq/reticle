#!/bin/sh
# Reticle, in one line:
#
#   curl -fsSL https://raw.githubusercontent.com/reticlehq/reticle/main/install/install.sh | sh
#
# A LAUNCHER, not the implementation. Its twin is `install.ps1`, for the stock Windows box that has
# no `sh` at all -- and the pair is safe for one reason only: there is almost nothing here to drift.
# Both do the same four things. Every real decision stays in Node (`reticle setup install`, which
# exists once); the launchers only ORDER the steps and choose what a new user reads. That last part
# lives here on purpose: this file is served from main, so first-run wording changes on merge,
# without an npm release. Logic still belongs in Node -- only sequencing and words belong here.
#
#   1. is there a usable `node`?
#   2. npm install -g @reticlehq/server
#   3. `reticle setup install`: register with the agents here (its closing tour is trimmed)
#   4. `reticle tutorial --run`: a real verdict on a demo app, then ONE next step
#
# ZERO HUMAN INPUT. Nothing is asked. The common case is an agent following a link somebody pasted,
# and a prompt there is a hang nobody sees. What gets written is announced by the command in step 3,
# which is also the thing that knows.
#
# `main "$@"` is the LAST line on purpose: a `curl | sh` cut off mid-download otherwise runs whatever
# prefix arrived. This way a truncated file defines functions and runs none of them.

set -e

RETICLE_PKG="@reticlehq/server"
# The floor the package declares in `engines`. Repeated here because nothing can read package.json
# before Node exists; `engines` stays the source of truth and this is the pre-Node echo of it.
NODE_MIN_MAJOR=20
# The MINOR matters too: `engines.node` on the published server is >=20.11, so 20.0-20.10 clears a
# major-only check and then fails at `npm i` with EBADENGINE, after the installer has said yes.
NODE_MIN_MINOR=11
STATE_DIR="${RETICLE_STATE_DIR:-$HOME/.reticle}"

say() { printf '%s\n' "$*" >&2; }
die() {
  say "reticle: $*"
  exit 1
}

# The ONE thing this script reports on its own, and only on failure.
#
# A pre-Node failure has nobody to emit it -- that is the whole reason for the handoff below. One
# line on disk means that if the person fixes the cause and installs later, the CLI drains it and
# the funnel shows a retry after a failure, which is exactly the shape worth seeing. If they never
# install, nothing is ever sent; that hole is real and bounded to machines with no Reticle on them.
note_failure() {
  [ "${RETICLE_TELEMETRY:-}" = "0" ] && return 0
  [ -n "${DO_NOT_TRACK:-}" ] && return 0
  [ -f "$STATE_DIR/telemetry-opt-out" ] && return 0
  mkdir -p "$STATE_DIR" 2>/dev/null || return 0
  printf '{"phase":"install","step":"%s","status":"failed","reason":"%s"}\n' "$1" "$2" \
    >>"$STATE_DIR/install-trace.jsonl" 2>/dev/null || true
}

check_node() {
  command -v node >/dev/null 2>&1 || {
    note_failure runtime_ready no_node
    die "Node $NODE_MIN_MAJOR+ is required and no \`node\` was found.

  macOS   brew install node
  Linux   https://nodejs.org/en/download/package-manager
  any     https://github.com/nvm-sh/nvm

Install Node, then run the same command again. Reticle does not install a runtime for you: a piped script that puts a language toolchain on your machine without asking is not something you should run, from us or from anybody."
  }
  major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  minor="$(node -p 'process.versions.node.split(".")[1]' 2>/dev/null || echo 0)"
  [ "$major" -ge "$NODE_MIN_MAJOR" ] || {
    note_failure runtime_ready node_too_old
    die "Node $major is too old -- Reticle needs $NODE_MIN_MAJOR.$NODE_MIN_MINOR or newer. Install a newer one (nodejs.org, or 'nvm install 22'), then run the same command again."
  }
  if [ "$major" -eq "$NODE_MIN_MAJOR" ] && [ "$minor" -lt "$NODE_MIN_MINOR" ]; then
    note_failure runtime_ready node_too_old
    die "Node $major.$minor is too old -- Reticle needs $NODE_MIN_MAJOR.$NODE_MIN_MINOR or newer. Install a newer one (nodejs.org, or 'nvm install 22'), then run the same command again."
  fi
}

install_cli() {
  command -v npm >/dev/null 2>&1 || {
    note_failure cli_installed no_npm
    die "npm was not found, and it ships with Node. Reinstall Node from nodejs.org."
  }
  # Braced, and ASCII. `$RETICLE_PKG...` put a multibyte ellipsis directly against the variable name
  # and `dash` swallowed the expansion whole -- the line printed "Installing " and two broken bytes.
  # bash was fine with it, which is exactly how a `curl | sh` bug reaches users: the author's shell
  # is not the one it runs in.
  # npm draws its progress bar only onto a TTY, and under `curl | sh` there is never one -- so it
  # prints nothing at all between here and its final summary. A cold cache makes that a silent
  # minute on the first thing anybody runs, reported from a real install as "sticks for a while",
  # and reported again after a note saying so was added: a note is not progress.
  say "[2/4] Installing ${RETICLE_PKG} (a cold npm cache takes about a minute)"
  log="$(mktemp)"
  npm install -g "$RETICLE_PKG" >"$log" 2>&1 &
  pid=$!
  secs=0
  # A counter redrawn in place, because silence reads as a hang.
  while kill -0 "$pid" 2>/dev/null; do
    [ -t 2 ] && printf '\r  installing... %ss' "$secs" >&2
    sleep 1
    secs=$((secs + 1))
  done
  [ -t 2 ] && printf '\r\033[K' >&2
  wait "$pid" || {
    cat "$log" >&2
    note_failure cli_installed npm_install
    die "npm could not install $RETICLE_PKG. Its output above says why."
  }
  say "  done: $(grep -E '^(added|changed|up to date)' "$log" | tail -n 1)"
  rm -f "$log"
  command -v reticle >/dev/null 2>&1 || {
    # Installed, but the global bin is not on PATH. Common, and reporting it as success would put
    # somebody in the funnel as installed while nothing they type works.
    note_failure cli_installed not_on_path
    die "Installed, but \`reticle\` is not on your PATH. Add npm's global bin directory:
  export PATH=\"\$(npm prefix -g)/bin:\$PATH\""
  }
}

main() {
  case "${1:-}" in
    -h | --help)
      say "usage: install.sh [--no-mcp]"
      exit 0
      ;;
  esac
  started="$(date +%s)"
  say "[1/4] Checking for Node $NODE_MIN_MAJOR.$NODE_MIN_MINOR+"
  check_node
  say "  found Node $(node -p 'process.versions.node')"
  runtime_done="$(date +%s)"
  install_cli
  installed="$(date +%s)"
  # Registration and its telemetry stay Node's. The WORDING after it is ours: this file is served
  # from main, so what a new user reads changes on merge instead of waiting for an npm release.
  # The tour and "Next" list `setup install` closes with are cut at their first line -- the demo
  # below shows those steps happening. If that line is ever reworded, the cut finds nothing and the
  # full text prints: noisy, never broken. Seconds, not milliseconds -- `date +%s%3N` is GNU-only.
  say "[3/4] Registering Reticle with the coding agents on this machine"
  out="$(mktemp)"
  # Inside an `if`, so `set -e` cannot exit before the output below is printed: a failure has to
  # show the reason it failed, not just the exit code.
  if reticle setup install \
    --runtime-secs "$((runtime_done - started))" \
    --install-secs "$((installed - runtime_done))" \
    "$@" >"$out" 2>&1; then
    rc=0
  else
    rc=$?
  fi
  sed '/Reticle is installed\. How it works/,$d' "$out"
  rm -f "$out"
  [ "$rc" -eq 0 ] || exit "$rc"

  # The aha, before anything touches the user's project: Reticle drives its own demo app to a real
  # verdict in seconds. No MCP reload and no instrumentation, so it works the same whether a person
  # or an agent ran this. A port the OS says is free, because any fixed one is somebody's (a test
  # install met an unrelated server on the first one picked). Run from a temp dir, so a crash log
  # never lands in whatever folder the user piped this from. Never fatal: Reticle is installed.
  say "[4/4] Watching Reticle verify a demo app"
  demo="$(mktemp)"
  port="$(node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')"
  if (cd "${TMPDIR:-/tmp}" && reticle tutorial --run --headless --port "$port") >"$demo" 2>&1; then
    grep -v -e '^{"t"' -e '^  why:' "$demo"
  else
    say "  skipped: no browser could start here. Reticle is installed; 'reticle doctor' says why."
  fi
  rm -f "$demo"

  # One next step. A terminal means a person. No terminal means an agent ran this, and an agent
  # cannot restart itself, so it gets the step that works in the session it is already in.
  say ""
  if [ -t 1 ]; then
    say "Done. Open your coding agent in your app's folder and ask:"
    say "  \"Verify one flow in my running app with Reticle.\""
    say "Agent already open? Restart it once so it loads Reticle's tools."
  else
    say "Done. Next, in the user's app folder: 'reticle init' wires the app and proves it connects."
    say "The reticle_* tools load when this agent session restarts. Cannot restart yourself? 'reticle init --relaunch' prints the command that resumes this conversation with the tools loaded."
  fi
}

main "$@"
