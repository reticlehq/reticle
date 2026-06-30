#!/usr/bin/env bash
#
# Publish @reticlehq/* to a LOCAL registry (Verdaccio) so you can install them into a real
# external app without publishing to public npm. Run from the repo root:
#
#   bash scripts/local-registry.sh
#
# Then, in your app:
#   echo '@reticle:registry=http://localhost:4873/' >> .npmrc
#   npm i -D @reticlehq/browser @reticlehq/react @reticlehq/next
#
set -euo pipefail
PORT=4873
REG="http://localhost:${PORT}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "==> Starting a FRESH Verdaccio on ${REG} (reset so user/token + versions are clean)"
pkill -f 'verdaccio --config' 2>/dev/null || true
lsof -tiTCP:"${PORT}" -sTCP:LISTEN 2>/dev/null | xargs kill 2>/dev/null || true
rm -rf /tmp/reticle-verdaccio-storage /tmp/reticle-verdaccio-htpasswd
sleep 1
npx --yes verdaccio@latest --config "${ROOT}/scripts/verdaccio.yaml" >/tmp/reticle-verdaccio.log 2>&1 &
for _ in $(seq 1 30); do curl -s "${REG}/-/ping" >/dev/null 2>&1 && break; sleep 1; done
curl -s "${REG}/-/ping" >/dev/null 2>&1 || { echo "Verdaccio did not start; see /tmp/reticle-verdaccio.log"; exit 1; }

echo "==> Creating registry user + token"
TOKEN=$(curl -s -XPUT "${REG}/-/user/org.couchdb.user:reticle" \
  -H 'Content-Type: application/json' \
  -d '{"_id":"org.couchdb.user:reticle","name":"reticle","password":"reticle","type":"user","roles":[],"date":"2026-01-01T00:00:00.000Z"}' \
  | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{process.stdout.write(JSON.parse(d).token||'')}catch{}})")
[ -n "${TOKEN}" ] || { echo "Failed to obtain a token from Verdaccio"; exit 1; }

echo "==> Publishing @reticlehq/* to ${REG}"
# Inject the token for this host only, publish, then strip it back out.
cleanup() { grep -v "localhost:${PORT}" "${HOME}/.npmrc" > "${HOME}/.npmrc.tmp" 2>/dev/null && mv "${HOME}/.npmrc.tmp" "${HOME}/.npmrc" || true; }
trap cleanup EXIT
printf '\n//localhost:%s/:_authToken=%s\n' "${PORT}" "${TOKEN}" >> "${HOME}/.npmrc"
( cd "${ROOT}" && pnpm -r publish --registry "${REG}" --no-git-checks )

echo ""
echo "✅ Published @reticlehq/* to ${REG}"
echo ""
echo "In your external app:"
echo "  echo '@reticle:registry=${REG}' >> .npmrc"
echo "  npm i -D @reticlehq/browser @reticlehq/react @reticlehq/next   # + @reticlehq/babel-plugin for non-Next"
echo "  npx --registry ${REG} @reticlehq/server              # run the bridge + MCP server"
