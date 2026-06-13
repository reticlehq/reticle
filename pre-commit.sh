#!/usr/bin/env bash
#
# Iris pre-commit quality gate. Symlinked to .git/hooks/pre-commit.
# Order: safety -> format -> lint -> types -> tests -> summary.
set -uo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT" || exit 1

fail=0
note() { printf "%b\n" "$1"; }
step() { printf "\n%b==> %s%b\n" "$YELLOW" "$1" "$NC"; }

# Staged files (added/copied/modified) as a newline string — portable (no mapfile,
# works on macOS bash 3.2). Each grep over it tolerates an empty list.
STAGED="$(git diff --cached --name-only --diff-filter=ACM)"
staged() { printf '%s\n' "$STAGED"; }
ts_staged() { staged | grep -E '\.(ts|tsx)$' || true; }

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
while IFS= read -r f; do
  [ -z "$f" ] && continue
  [ -f "$f" ] || continue
  if grep -nE '(:[[:space:]]*any\b|<any>|as any\b|any\[\])' "$f" >/dev/null; then
    note "${RED}✗ 'any' type in $f${NC}"; fail=1
  fi
  if grep -nE '\bconsole\.log\b' "$f" >/dev/null; then
    note "${RED}✗ console.log in $f (use console.warn/error or structured logging)${NC}"; fail=1
  fi
  lines=$(wc -l < "$f" | tr -d ' ')
  if [ "$lines" -gt 500 ]; then
    note "${RED}✗ $f is $lines lines (> 500 cap) — split it${NC}"; fail=1
  fi
  if grep -nE 'eslint-disable(-next-line|-line)?' "$f" | grep -vq -- '--'; then
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
  if grep -nE '(//|#)[^"'"'"'`]*\b[0-9]+\.[0-9]+\.[0-9]+\b' "$f" >/dev/null 2>&1; then
    note "${RED}✗ version string in comment in $f — remove internal milestone labels${NC}"; fail=1
  fi
done < <(ts_staged)

[ "$fail" -eq 0 ] && note "${GREEN}✓ safety${NC}"

# ----- 2. FORMAT -----------------------------------------------------------
step "Prettier (format check)"
if ! pnpm -s format:check; then note "${RED}✗ prettier${NC}"; fail=1; else note "${GREEN}✓ format${NC}"; fi

# ----- 3. LINT -------------------------------------------------------------
step "ESLint"
if ! pnpm -s lint; then note "${RED}✗ eslint${NC}"; fail=1; else note "${GREEN}✓ lint${NC}"; fi

# ----- 4. TYPES ------------------------------------------------------------
step "TypeScript (tsc --build)"
if ! pnpm -s typecheck; then note "${RED}✗ types${NC}"; fail=1; else note "${GREEN}✓ types${NC}"; fi

# ----- 5. TESTS ------------------------------------------------------------
step "Unit tests (vitest)"
if ! pnpm -s test:unit; then note "${RED}✗ tests${NC}"; fail=1; else note "${GREEN}✓ tests${NC}"; fi

# ----- 6. SUMMARY ----------------------------------------------------------
if [ "$fail" -ne 0 ]; then
  note "\n${RED}✗ pre-commit FAILED — commit blocked${NC}"
  exit 1
fi
note "\n${GREEN}✓ all checks passed${NC}"
exit 0
