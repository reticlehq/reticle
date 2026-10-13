#!/bin/sh
# Reticle, in one line:
#
#   curl -fsSL https://raw.githubusercontent.com/reticlehq/reticle/main/install/install.sh | sh
#
# A LAUNCHER, not the implementation. Its twin is `install.ps1`, for the stock Windows box that has
# no `sh` at all -- and the pair is safe for one reason only: there is almost nothing here to drift.
# Both do the same three things. Every real decision stays in Node (`reticle setup install`, which
# exists once); the launchers only ORDER the steps and choose what a new user reads. That last part
# lives here on purpose: this file is served from main, so first-run wording changes on merge,
# without an npm release. Logic still belongs in Node -- only sequencing and words belong here.
#
#   1. is there a usable `node`?
#   2. npm install -g @reticlehq/server
#   3. `reticle setup install`: register with the agents here (its closing tour is trimmed)
#
# Then ONE next step, and it is `reticle init`: nothing above touched the user's app. A demo verdict
# used to close this script, and from the field it read as "Reticle is in my app" -- a person saw a
# session connect and a `verified: yes`, went to the dashboard, and found nothing wired. The first
# verdict a person sees is now one on their own app. Beside it, the prompt to paste into a coding
# agent instead, fetched from reticle.sh (see `fetch_prompt`) and only ever printed.
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

# Colour only for a person: a terminal, NO_COLOR unset, a terminal that can draw it. Everything an
# agent or a log reads stays plain text.
# The tick and the cross, built from octal escapes because this file is ASCII only (see README).
CHECK="$(printf '\342\234\223')"
CROSS="$(printf '\342\234\227')"
paint() { [ -t "$1" ] && [ -z "${NO_COLOR:-}" ] && [ "${TERM:-}" != "dumb" ]; }
if paint 2; then
  ERR_ON="$(printf '\033[1;31m')"
  OK_ON="$(printf '\033[32m')"
  DIM_ON="$(printf '\033[2m')"
  OFF="$(printf '\033[0m')"
else
  ERR_ON=""
  OK_ON=""
  DIM_ON=""
  OFF=""
fi
if paint 1; then
  HEAD_ON="$(printf '\033[1;36m')"
  BOLD_ON="$(printf '\033[1m')"
  DIM_OUT="$(printf '\033[2m')"
  OUT_OFF="$(printf '\033[0m')"
else
  HEAD_ON=""
  BOLD_ON=""
  DIM_OUT=""
  OUT_OFF=""
fi

say() { printf '%s\n' "$*" >&2; }
ok() { say "${OK_ON}${CHECK}${OFF} $*"; }
# Errors are the loud part: a red line on its own, then the fix.
die() {
  say ""
  say "${ERR_ON}${CROSS} Reticle was not installed.${OFF}"
  say "$*"
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
    die "Node $NODE_MIN_MAJOR.$NODE_MIN_MINOR+ is required and no \`node\` was found.

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

# What the closing tells the person to type. `reticle` unless the bin it landed in is not on PATH,
# when it is the full path, so every printed command works in the shell they are reading it in.
RETICLE_BIN="reticle"
# Set when that bin is not on PATH: the next steps lead with the one line that puts it there.
PATH_DIR=""
SHADOWED_BY=""

# `npm install -g`, with a counter: npm draws no progress under `curl | sh`, so a cold cache is a
# silent minute and silence reads as a hang. Extra arguments go to npm. Leaves npm's output in $log.
npm_global() {
  log="$(mktemp)"
  npm install -g "$@" "$RETICLE_PKG" >"$log" 2>&1 &
  pid=$!
  [ -t 2 ] || say "  installing ${RETICLE_PKG} (up to a minute on a cold npm cache)"
  secs=0
  while kill -0 "$pid" 2>/dev/null; do
    [ -t 2 ] && printf '\r%s  installing %s... %ss%s' "$DIM_ON" "$RETICLE_PKG" "$secs" "$OFF" >&2
    sleep 1
    secs=$((secs + 1))
  done
  [ -t 2 ] && printf '\r\033[K' >&2
  wait "$pid"
}

# What npm's failure means, when it is one a person meets on a company network. npm's own words for
# both are a stack trace and "If you are behind a proxy, please make sure that the 'proxy' config is
# set properly", which names neither setting.
npm_failure() {
  if grep -qE 'SELF_SIGNED|UNABLE_TO_GET_ISSUER|UNABLE_TO_VERIFY|CERT_' "$log"; then
    printf '%s' "Something between this machine and npm re-signs HTTPS (a company proxy). Point Node at its certificate: export NODE_EXTRA_CA_CERTS=/path/to/company-ca.pem (or npm config set cafile /path/to/company-ca.pem), then run the same command again."
  elif grep -qE 'ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|ECONNRESET|ENETUNREACH' "$log"; then
    printf '%s' "npm could not reach its registry ($(npm config get registry 2>/dev/null)). Behind a proxy: npm config set proxy http://host:port and npm config set https-proxy http://host:port. On a network that blocks npm, use your company's mirror: npm config set registry <url>. Then run the same command again."
  else
    printf '%s' "npm could not install $RETICLE_PKG. Its output above says why; fix that, then run the same command again."
  fi
}

install_cli() {
  command -v npm >/dev/null 2>&1 || {
    note_failure cli_installed no_npm
    die "npm was not found, and it ships with Node. Reinstall Node from nodejs.org."
  }
  # Braced, and ASCII next to a variable: `dash` swallowed a multibyte ellipsis written straight
  # after a variable name, and bash did not, which is how a `curl | sh` bug reaches users.
  if ! npm_global; then
    # A Node from a system package or the nodejs.org .pkg keeps its global folder root-owned, so
    # `npm install -g` needs sudo. Telling somebody to fix npm before they can try Reticle ended the
    # install; a folder of our own needs no sudo and nothing else on the machine changes.
    if grep -qE 'EACCES|EPERM' "$log"; then
      rm -f "$log"
      user_prefix="$STATE_DIR/npm"
      say "  npm's global folder needs sudo here; installing into $user_prefix instead"
      npm_global --prefix "$user_prefix" || {
        cat "$log" >&2
        note_failure cli_installed npm_install
        die "$(npm_failure)"
      }
      PATH_DIR="$user_prefix/bin"
    else
      cat "$log" >&2
      note_failure cli_installed npm_install
      die "$(npm_failure)"
    fi
  fi
  rm -f "$log"
  [ -n "$PATH_DIR" ] || PATH_DIR="$(npm prefix -g 2>/dev/null)/bin"
  # Installed, and the bin may not be on PATH in THIS shell (a custom npm prefix, a Node installed a
  # minute ago, the folder above). That used to end the install before any agent was registered;
  # the full path finishes it, and the next steps say how to put the folder on PATH.
  found="$(command -v reticle 2>/dev/null || true)"
  if [ -x "$PATH_DIR/reticle" ] && [ "$found" != "$PATH_DIR/reticle" ]; then
    RETICLE_BIN="$PATH_DIR/reticle"
    # Another `reticle` first on PATH (an older global install, another prefix) would run the OLD
    # version on every command typed after this; the next steps name it.
    SHADOWED_BY="$found"
  elif [ -x "$PATH_DIR/reticle" ] || [ -n "$found" ]; then
    # ponytail: a version manager whose shims are not in `npm prefix -g` (Volta) lands here and is
    # trusted as is; teach it the shim directory if its users report a stale CLI.
    PATH_DIR=""
  else
    note_failure cli_installed not_on_path
    die "npm says it installed $RETICLE_PKG, but no \`reticle\` was found on PATH or in $PATH_DIR."
  fi
  ok "Installed $RETICLE_PKG"
}

# The line that puts PATH_DIR on PATH for this shell and every new one, in the person's own shell.
# Under $HOME it is written with `$HOME`, so the line reads as a folder rather than a wall of path.
path_line() {
  dir="$PATH_DIR"
  case "$dir" in "$HOME"/*) dir="\$HOME${dir#"$HOME"}" ;; esac
  case "$(basename "${SHELL:-sh}")" in
    fish) printf 'fish_add_path %s' "$dir" ;;
    zsh) printf 'export PATH="%s:$PATH"; echo '"'"'export PATH="%s:$PATH"'"'"' >> ~/.zshrc' "$dir" "$dir" ;;
    bash)
      rc="~/.bashrc"
      [ "$(uname -s 2>/dev/null)" = "Darwin" ] && rc="~/.bash_profile"
      printf 'export PATH="%s:$PATH"; echo '"'"'export PATH="%s:$PATH"'"'"' >> %s' "$dir" "$dir" "$rc"
      ;;
    *) printf 'export PATH="%s:$PATH"; echo '"'"'export PATH="%s:$PATH"'"'"' >> ~/.profile' "$dir" "$dir" ;;
  esac
}

# The prompt a person pastes into their coding agent to put Reticle in their project. Fetched, so
# its wording improves without a release; this copy is what prints when the fetch is off or fails,
# and it says the same thing as the published file.
AGENT_PROMPT_URL="${RETICLE_AGENT_PROMPT_URL:-https://reticle.sh/install/agent-prompt.v1.json}"
FALLBACK_TITLE="Add Reticle to this project"
fallback_prompt() {
  cat <<'PROMPT'
Instrument this app with Reticle so its user flows can be verified from inside the running app.

1. In the app's folder (the one with its package.json), run `reticle init` (or `npx @reticlehq/server init` if `reticle` is not on PATH). Do what its output says, including restarting a dev server that was already running. If the reticle_* tools only load after a restart you cannot do yourself, run `reticle init --relaunch` and follow what it prints.
2. Run `reticle doctor`. Its coverage row lists what Reticle cannot see yet (missing, not seen yet) and the fix for each. Close every gap this app allows:
   - signals: call reticle.signal(name, data) where each user-visible outcome is committed (saved, sent, deleted, signed in);
   - stable test ids: add data-testid to the controls your flows use;
   - file:line source mapping: keep the Reticle build plugin init added (@reticlehq/vite-plugin, @reticlehq/next or the babel plugin);
   - app state: if the app has a store, register it with reticle.registerStore(name, store).
3. Verify one real user flow end to end: drive it with reticle_act_and_wait and give the last step an `until` that names the end state (the signal you added is the strongest). Only verified: "yes" is a pass; "unknown" is not. A passing flow is saved and replays without a model.
4. Run `reticle doctor` again and close what the verdict revealed.
5. Run `reticle connect` to sign in, link this project and sync the flow to the dashboard.
6. Tell me what you changed, which gaps remain and why, the flow you verified and its verdict.
PROMPT
}

# The same opt-outs the daemon honours for its notices fetch: somebody who switched Reticle's
# outbound calls off asked for none, even one that sends nothing about them.
outbound_off() {
  telemetry="$(printf '%s' "${RETICLE_TELEMETRY:-}" | tr '[:upper:]' '[:lower:]')"
  case "$telemetry" in 0 | false | off) return 0 ;; esac
  [ -n "${DO_NOT_TRACK:-}" ] && [ "${DO_NOT_TRACK:-}" != "0" ] && return 0
  return 1
}

# Prints a title line, then the prompt, or fails. The body is DATA: it is parsed by Node, checked,
# stripped of every control character but the newline (so no escape sequence reaches the terminal),
# and only ever printed. Nothing fetched is evaluated, sourced or run.
fetch_prompt() {
  outbound_off && return 1
  if command -v curl >/dev/null 2>&1; then
    body="$(curl -fsSL --max-time 3 --max-filesize 65536 "$AGENT_PROMPT_URL" 2>/dev/null)" || return 1
  elif command -v wget >/dev/null 2>&1; then
    body="$(wget -q -T 3 -t 1 -O - "$AGENT_PROMPT_URL" 2>/dev/null | head -c 65536)" || return 1
  else
    return 1
  fi
  printf '%s' "$body" | node -e '
    let raw = "";
    process.stdin.on("data", (c) => (raw += c));
    process.stdin.on("end", () => {
      const clean = (t) => t.replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "");
      let file;
      try { file = JSON.parse(raw); } catch { process.exit(1); }
      if (null === file || "object" !== typeof file || Array.isArray(file)) process.exit(1);
      if (1 !== file.version || "string" !== typeof file.prompt) process.exit(1);
      if (file.prompt.length > 4000) process.exit(1);
      const prompt = clean(file.prompt).trim();
      if ("" === prompt) process.exit(1);
      const title = "string" === typeof file.title ? clean(file.title).replace(/\n/g, " ").trim().slice(0, 80) : "";
      process.stdout.write(title + "\n" + prompt + "\n");
    });' 2>/dev/null
}

next_step() {
  mcp="$1"
  # From `reticle setup install`'s RETICLE_INSTALL line; empty from a CLI too old to print one.
  agents="$2"
  app="$3"
  if fetched="$(fetch_prompt)"; then
    title="$(printf '%s\n' "$fetched" | head -n 1)"
    prompt="$(printf '%s\n' "$fetched" | tail -n +2)"
  else
    title=""
    prompt="$(fallback_prompt)"
  fi
  [ -n "$title" ] || title="$FALLBACK_TITLE"
  rule="------------------------------------------------------------"
  # A terminal means a person; no terminal means an agent ran this, and the words name the user.
  if [ -t 1 ]; then app_name="your app"; else app_name="the user's app"; fi
  if [ "$app" = "here" ]; then
    init_cmd="${BOLD_ON}${RETICLE_BIN} init${OUT_OFF} in this folder"
  else
    init_cmd="${BOLD_ON}cd your-app && ${RETICLE_BIN} init${OUT_OFF}"
  fi
  printf '\n%sNext steps%s\n' "$HEAD_ON" "$OUT_OFF"
  printf 'Reticle is on this machine, not in %s yet.\n\n' "$app_name"
  if [ -n "$PATH_DIR" ]; then
    if [ -n "$SHADOWED_BY" ]; then
      printf '  0. The %sreticle%s first on your PATH is another install (%s). Put this one first:\n' "$BOLD_ON" "$OUT_OFF" "$SHADOWED_BY"
    else
      printf '  0. %sreticle%s is not on your PATH yet. Put it there for this shell and new ones:\n' "$BOLD_ON" "$OUT_OFF"
    fi
    printf '       %s\n' "$(path_line)"
    printf '     Until then, %s works.\n' "$RETICLE_BIN"
  fi
  if [ "$mcp" -eq 0 ]; then
    printf '  1. No coding agent was registered (--no-mcp). To register one: %sreticle setup mcp%s\n' "$BOLD_ON" "$OUT_OFF"
    printf '  2. Paste the prompt below into it. It instruments %s and proves one flow.\n' "$app_name"
    printf '  3. No agent? Run %s,\n' "$init_cmd"
    printf '     then press %sRun Harness%s in the Reticle panel, or run %sreticle connect%s.\n' "$BOLD_ON" "$OUT_OFF" "$BOLD_ON" "$OUT_OFF"
  elif [ "$agents" = "0" ]; then
    printf '  1. No coding agent was found, so none has Reticle'"'"'s tools. Run %s:\n' "$init_cmd"
    printf '     it wires %s, starts it and connects it to Reticle.\n' "$app_name"
    printf '  2. Then press %sRun Harness%s in the Reticle panel, or run %sreticle connect%s.\n' "$BOLD_ON" "$OUT_OFF" "$BOLD_ON" "$OUT_OFF"
    printf '  3. Add a coding agent later? Run %sreticle setup mcp%s, then paste it the prompt below.\n' "$BOLD_ON" "$OUT_OFF"
  else
    printf '  1. Coding agent already open? Restart it so it loads Reticle'"'"'s tools.\n'
    printf '  2. Paste the prompt below into it. It instruments %s and proves one flow.\n' "$app_name"
    printf '  3. No agent? Run %s,\n' "$init_cmd"
    printf '     then press %sRun Harness%s in the Reticle panel, or run %sreticle connect%s.\n' "$BOLD_ON" "$OUT_OFF" "$BOLD_ON" "$OUT_OFF"
  fi
  printf '\n%s%s%s\n' "$HEAD_ON" "$rule" "$OUT_OFF"
  printf '%sPaste this into your coding agent%s  %s(%s)%s\n' "$HEAD_ON" "$OUT_OFF" "$DIM_OUT" "$title" "$OUT_OFF"
  printf '%s%s%s\n\n' "$HEAD_ON" "$rule" "$OUT_OFF"
  printf '%s\n' "$prompt"
  printf '\n%s%s%s\n' "$HEAD_ON" "$rule" "$OUT_OFF"
}

main() {
  case "${1:-}" in
    -h | --help)
      say "usage: install.sh [--no-mcp]"
      exit 0
      ;;
  esac
  started="$(date +%s)"
  say "Installing Reticle"
  check_node
  ok "Node $(node -p 'process.versions.node')"
  runtime_done="$(date +%s)"
  install_cli
  installed="$(date +%s)"
  # Registration and its telemetry stay Node's. The WORDING after it is ours: this file is served
  # from main, so what a new user reads changes on merge instead of waiting for an npm release.
  # `setup install` closes with a tour; it is cut at its first line, because the next step below
  # replaces it. If that line is ever reworded the cut finds nothing and the tour prints: noisy,
  # never broken. Seconds, not milliseconds -- `date +%s%3N` is GNU-only.
  out="$(mktemp)"
  # Inside an `if`, so `set -e` cannot exit before the output below is printed: a failure has to
  # show the reason it failed, not just the exit code.
  if "$RETICLE_BIN" setup install \
    --runtime-secs "$((runtime_done - started))" \
    --install-secs "$((installed - runtime_done))" \
    "$@" >"$out" 2>&1; then
    rc=0
  else
    rc=$?
  fi
  if [ "$rc" -ne 0 ]; then
    # Node reports this failure itself; the shell only makes it impossible to miss.
    cat "$out" >&2
    rm -f "$out"
    say ""
    say "${ERR_ON}${CROSS} Reticle is on this machine, but registering it with your coding agents failed.${OFF}"
    say "The output above says why. Fix that, then run: reticle setup mcp"
    exit "$rc"
  fi
  mcp=1
  case " $* " in *" --no-mcp "*) mcp=0 ;; esac
  # The CLI's one machine line: how many agents have the tools, and whether this folder is an app.
  result="$(grep '^RETICLE_INSTALL ' "$out" | tail -n 1)"
  agents="$(printf '%s' "$result" | sed -n 's/.* agents=\([0-9]*\).*/\1/p')"
  app="$(printf '%s' "$result" | sed -n 's/.* app=\([a-z]*\).*/\1/p')"
  if [ "$mcp" -eq 0 ]; then
    ok "Skipped registering with coding agents (--no-mcp)"
  elif [ "$agents" = "0" ]; then
    say "  No coding agent found on this machine, so none was registered."
    sed -e '/^RETICLE_INSTALL /d' -e '/Reticle is installed/,$d' -e '/^[[:space:]]*$/d' "$out" >&2
  else
    ok "Registered with the coding agents on this machine"
    sed -e '/^RETICLE_INSTALL /d' -e '/Reticle is installed/,$d' -e '/^[[:space:]]*$/d' "$out" >&2
  fi
  rm -f "$out"
  next_step "$mcp" "$agents" "$app"
}

main "$@"
