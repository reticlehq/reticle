#!/usr/bin/env bash
#
# Reticle sign-off hook. Symlinked to .git/hooks/prepare-commit-msg.
#
# Appends the `Signed-off-by:` trailer CI's DCO check requires, so a forgotten `-s` cannot reach a
# PR. This exists because the obvious-looking config does NOT do it: `git config format.signOff true`
# applies to `format-patch`/`send-email` and has no effect on `git commit`, so setting it produces
# unsigned commits and the confidence that they are signed. That combination is what put 122
# unsigned commits on this repo's history.
#
# `interpret-trailers` places the trailer correctly and is a no-op when one is already there, so
# `git commit -s` and this hook cannot double up.
set -uo pipefail

MSG_FILE="$1"
SOURCE="${2-}"

# A merge has no authored change to certify, and the DCO check exempts merge commits.
[ "$SOURCE" = "merge" ] && exit 0

IDENT="$(git var GIT_AUTHOR_IDENT)"
NAME="${IDENT%% <*}"
EMAIL="${IDENT#*<}"; EMAIL="${EMAIL%%>*}"

git interpret-trailers --in-place --if-exists doNothing \
  --trailer "Signed-off-by: $NAME <$EMAIL>" "$MSG_FILE"
