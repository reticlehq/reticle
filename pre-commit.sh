#!/usr/bin/env bash
#
# Reticle pre-commit quality gate. Symlinked to .git/hooks/pre-commit.
# Order: safety -> format -> lint -> types -> tests -> summary.
set -uo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
# Ask git which tree is being committed, rather than deriving it from this script's own path.
# `.git/hooks/pre-commit` is a symlink into the MAIN checkout, so `BASH_SOURCE[0]` resolved there
# no matter which worktree ran `git commit` -- the hook then read `git diff --cached` in the main
# checkout and verified a tree nobody was committing. With two worktrees open on this repo that is
# a gate reporting green over the wrong files.
ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT" || exit 1

fail=0
note() { printf "%b\n" "$1"; }
step() { printf "\n%b==> %s%b\n" "$YELLOW" "$1" "$NC"; }

# Staged files (added/copied/modified) as a newline string — portable (no mapfile,
# works on macOS bash 3.2). Each grep over it tolerates an empty list.
STAGED="$(git diff --cached --name-only --diff-filter=ACM)"
staged() { printf '%s\n' "$STAGED"; }
# Source this hook checks. `.mjs`/`.cjs` are included because the largest file in the repo is one
# (`setup/reticle.mjs`, the thing a new user runs) and it had never been subject to any check below.
# `apps/` and `bench/` are fixtures and measurement scratch, deliberately outside every gate.
ts_staged() { staged | grep -E '\.(ts|tsx|mjs|cjs)$' | grep -vE '^(apps|bench)/' || true; }

# ----- 1. SAFETY -----------------------------------------------------------
step "Safety checks"

# 1a. plan/ never ships
if staged | grep -qE '^plan/'; then
  note "${RED}✗ plan/ files are staged — research never ships${NC}"; fail=1
fi

# 1b. .env never committed (only .env.example)
if staged | grep -E '(^|/)\.env($|\.)' | grep -qv '\.env\.example'; then
  note "${RED}✗ a .env file is staged${NC}"; fail=1
fi

# 1c. obvious secrets in the added lines
if git diff --cached -U0 2>/dev/null \
    | grep -E '^\+' \
    | grep -Eiq '(api[_-]?key|secret|password|private[_-]?key)["'"'"']?[[:space:]]*[:=][[:space:]]*["'"'"'][A-Za-z0-9/_+-]{12,}'; then
  note "${RED}✗ possible hardcoded secret in staged changes${NC}"; fail=1
fi

# 1d. no `any`, no console.log, file size, bare eslint-disable
#
# These four mirror rules that `eslint.config.mjs` also enforces, and they must agree with it: a hook
# that is STRICTER than the linter fails a commit that `pnpm lint` calls clean, which teaches everyone
# to reach for --no-verify. It disagreed on three of the four, and the two text checks matched English
# prose, so a comment reading "the same path as any other captured body" was reported as an `any` type.
# Fifteen such reports blocked one commit and not one of them was a real violation.
code_only() { grep -vE '^[[:space:]]*(\*|//|/\*)' "$1" | sed -E 's;//.*;;'; }
while IFS= read -r f; do
  [ -z "$f" ] && continue
  [ -f "$f" ] || continue
  # Comment lines are stripped first, and `any` must sit where a TYPE can end -- before `)`, `,`, `;`,
  # `=`, `>`, `[`, `|`, `&`, `}` or end of line. `any` is an ordinary English word, so after a colon it
  # is indistinguishable from an annotation: a doc comment reading "the same path as any other captured
  # body" and a user-facing string reading "watch: any tab of that app" were both reported as types.
  if code_only "$f" | grep -qE '(:[[:space:]]*any[[:space:]]*([),;=>|&}[]|$)|<any>|as any[[:space:]]*([),;=>|&}[]|$)|any\[\])'; then
    note "${RED}✗ 'any' type in $f${NC}"; fail=1
  fi
  # Flag console.log CALLS only (followed by `(`), not the substring — a wire constant whose VALUE is
  # the string 'console.log' (e.g. EventType.CONSOLE_LOG) is legitimate and must not trip the gate.
  # Skipped for .js/.mjs/.cjs, where `eslint.config.mjs` turns `no-console` off: those are build and
  # codegen scripts whose stdout IS their interface.
  case "$f" in
    *.js|*.mjs|*.cjs) ;;
    *) if code_only "$f" | grep -qE '\bconsole\.log[[:space:]]*\('; then
         note "${RED}✗ console.log in $f (use console.warn/error or structured logging)${NC}"; fail=1
       fi ;;
  esac
  # The 1000-line cap, exempting tests exactly as `eslint.config.mjs` does: a fixture catalogue is long
  # for a different reason than a god file is.
  case "$f" in
    *.test.ts|*.test.tsx) ;;
    *) lines=$(wc -l < "$f" | tr -d ' ')
       if [ "$lines" -gt 1000 ]; then
         note "${RED}✗ $f is $lines lines (> 1000 cap) — split it${NC}"; fail=1
       fi ;;
  esac
  # The directive must FOLLOW a comment opener. Matching the bare word caught prose describing the
  # rule ("an eslint-disable per call site"), which has no `--` and so always failed.
  if grep -nE '(//|/\*)[[:space:]]*eslint-disable(-next-line|-line)?' "$f" | grep -vq -- '--'; then
    note "${RED}✗ eslint-disable without a '-- reason' in $f${NC}"; fail=1
  fi
done < <(ts_staged)

# 1e. component files must use create-, not new-
if staged | grep -E '(components|views|features)/' | grep -qE '/new-[^/]+\.(ts|tsx)$'; then
  note "${RED}✗ component file prefixed 'new-' — use 'create-'${NC}"; fail=1
fi

# 1f. no internal tracking tags in source files
# Rejects: design-doc codes (G4, N5, M8, P2, F1, R1, …) and version labels (0.3.7) in comments.
# Matches lines that start with a comment marker (// or #) and contain a bare letter+digit token
# or a semver-like string. Skips the pre-commit.sh itself and skills/ docs (those explain the rule).
while IFS= read -r f; do
  [ -z "$f" ] && continue
  [ -f "$f" ] || continue
  case "$f" in pre-commit.sh|skills/*) continue;; esac
  if grep -nE '(//|#)[^"'"'"'`]*\b[A-Z][0-9]+(\.[0-9]+)?\b' "$f" >/dev/null 2>&1; then
    note "${RED}✗ internal tracking tag (e.g. N5, G4, M8) in comment in $f — use prose instead${NC}"; fail=1
  fi
  # Blank out IPv4 addresses (four dotted octets) before the semver check — 127.0.0.1 in a
  # DNS-rebinding comment is not an internal milestone label. A real X.Y.Z surviving is flagged.
  if grep -nE '(//|#)[^"'"'"'`]*\b[0-9]+\.[0-9]+\.[0-9]+\b' "$f" 2>/dev/null \
       | sed -E 's/[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}//g' \
       | grep -qE '\b[0-9]+\.[0-9]+\.[0-9]+\b'; then
    note "${RED}✗ version string in comment in $f — remove internal milestone labels${NC}"; fail=1
  fi
done < <(ts_staged)

[ "$fail" -eq 0 ] && note "${GREEN}✓ safety${NC}"

# Steps 2-7 mirror CI (.github/workflows/ci.yml) one-for-one so a green commit is a green CI run:
# build -> format -> lint -> types -> tests -> audit. Keep this list in sync with ci.yml.

# ----- 2. BUILD ------------------------------------------------------------
step "Build (turbo)"
if ! pnpm -s build; then note "${RED}✗ build${NC}"; fail=1; else note "${GREEN}✓ build${NC}"; fi

# ----- 3. LINT -------------------------------------------------------------
step "ESLint"
if ! pnpm -s lint; then note "${RED}✗ eslint${NC}"; fail=1; else note "${GREEN}✓ lint${NC}"; fi

# ----- 4. TYPES ------------------------------------------------------------
step "TypeScript (tsc --build)"
if ! pnpm -s typecheck; then note "${RED}✗ types${NC}"; fail=1; else note "${GREEN}✓ types${NC}"; fi

# ----- 5. TESTS ------------------------------------------------------------
step "Unit tests (vitest)"
if ! pnpm -s test:unit; then note "${RED}✗ tests${NC}"; fail=1; else note "${GREEN}✓ tests${NC}"; fi

# ----- 6. AUDIT ------------------------------------------------------------
# Non-blocking, matching CI: a newly-published advisory on an untouched transitive dep must not block
# a commit. It still runs and surfaces, so a high+ vuln is visible before push; act on it with a
# dependency bump / pnpm override, not by blocking the commit.
step "Security audit (--audit-level high, non-blocking)"
if ! pnpm audit --audit-level high; then note "${YELLOW}⚠ audit (high+ advisory — non-blocking; review & bump)${NC}"; else note "${GREEN}✓ audit${NC}"; fi

# ----- 7. FORMAT -----------------------------------------------------------
step "Prettier (format check)"
if ! pnpm -s format:check; then note "${RED}✗ prettier${NC}"; fail=1; else note "${GREEN}✓ format${NC}"; fi

# ----- 8. SUMMARY ----------------------------------------------------------
if [ "$fail" -ne 0 ]; then
  note "\n${RED}✗ pre-commit FAILED — commit blocked${NC}"
  exit 1
fi
note "\n${GREEN}✓ all checks passed${NC}"
exit 0
