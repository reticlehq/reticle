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

# Staged files (added/copied/modified), text only.
mapfile -t STAGED < <(git diff --cached --name-only --diff-filter=ACM)
ts_staged() { printf '%s\n' "${STAGED[@]}" | grep -E '\.(ts|tsx)$' || true; }

# ----- 1. SAFETY -----------------------------------------------------------
step "Safety checks"

# 1a. plan/ never ships
if printf '%s\n' "${STAGED[@]}" | grep -qE '^plan/'; then
  note "${RED}✗ plan/ files are staged — research never ships${NC}"; fail=1
fi

# 1b. .env never committed (only .env.example)
if printf '%s\n' "${STAGED[@]}" | grep -qE '(^|/)\.env($|\.)' | grep -qv '\.env\.example'; then
  note "${RED}✗ a .env file is staged${NC}"; fail=1
fi

# 1c. obvious secrets
if [ "${#STAGED[@]}" -gt 0 ]; then
  if git diff --cached -U0 -- "${STAGED[@]}" 2>/dev/null \
      | grep -E '^\+' \
      | grep -Eiq '(api[_-]?key|secret|password|private[_-]?key)["'"'"']?\s*[:=]\s*["'"'"'][A-Za-z0-9/_+-]{12,}'; then
    note "${RED}✗ possible hardcoded secret in staged changes${NC}"; fail=1
  fi
fi

# 1d. no `any`, no console.log, file size, new- prefix, bare eslint-disable
while IFS= read -r f; do
  [ -z "$f" ] && continue
  [ -f "$f" ] || continue
  if grep -nE '(:\s*any\b|<any>|as any\b|any\[\])' "$f" >/dev/null; then
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
if printf '%s\n' "${STAGED[@]}" \
    | grep -E '(components|views|features)/.*' \
    | grep -qE '/new-[^/]+\.(ts|tsx)$'; then
  note "${RED}✗ component file prefixed 'new-' — use 'create-'${NC}"; fail=1
fi

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
