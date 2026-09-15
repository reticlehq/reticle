#!/bin/sh
# Reticle, in one line:
#
#   curl -fsSL https://reticle.sh/install.sh | sh
#
# A LAUNCHER, not the implementation. Its twin is `install.ps1`, for the stock Windows box that has
# no `sh` at all -- and the pair is safe for one reason only: there is almost nothing here to drift.
# Both do the same three things and hand every real decision to `reticle setup install`, which is
# Node and exists once. The moment either launcher grows a fourth responsibility that stops being
# true, and the logic belongs in the Node command instead.
#
# So this does only the three things that CANNOT be Node, because Node may not exist yet:
#
#   1. is there a usable `node`?
#   2. npm install -g @reticlehq/server
#   3. hand every other decision to `reticle setup install`
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

Reticle does not install a runtime for you. A piped script that puts a language toolchain on your
machine without asking is not something you should run, from us or from anybody."
  }
  major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  [ "$major" -ge "$NODE_MIN_MAJOR" ] || {
    note_failure runtime_ready node_too_old
    die "Node $major is too old -- Reticle needs $NODE_MIN_MAJOR or newer."
  }
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
  say "Installing ${RETICLE_PKG}..."
  npm install -g "$RETICLE_PKG" >&2 || {
    note_failure cli_installed npm_install
    die "npm could not install $RETICLE_PKG. Its output above says why."
  }
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
  check_node
  runtime_done="$(date +%s)"
  install_cli
  installed="$(date +%s)"
  # Everything else is Node's: writing the steps, registering the MCP server with the agents that
  # are here, and saying what happened. Seconds, not milliseconds -- `date +%s%3N` is GNU-only and
  # macOS has no %N at all, and a duration silently 1000x out is worse than one that is coarse.
  exec reticle setup install \
    --runtime-secs "$((runtime_done - started))" \
    --install-secs "$((installed - runtime_done))" \
    "$@"
}

main "$@"
