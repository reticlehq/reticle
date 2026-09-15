#!/usr/bin/env bash
#
# Publish @reticlehq/* to a LOCAL registry (Verdaccio) so you can install them into a real
# external app without publishing to public npm. Run from the repo root:
#
#   bash scripts/local-registry.sh
#
# Then, in your app:
#   echo '@reticlehq:registry=http://localhost:4873/' >> .npmrc
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

echo "==> Publishing every publishable workspace package to ${REG}"
# Inject the token for this host only, publish, then strip it back out.
cleanup() { grep -v "localhost:${PORT}" "${HOME}/.npmrc" > "${HOME}/.npmrc.tmp" 2>/dev/null && mv "${HOME}/.npmrc.tmp" "${HOME}/.npmrc" || true; }
trap cleanup EXIT
printf '\n//localhost:%s/:_authToken=%s\n' "${PORT}" "${TOKEN}" >> "${HOME}/.npmrc"
( cd "${ROOT}" && pnpm -r publish --registry "${REG}" --no-git-checks )

# Verify the publish, rather than trusting its exit code.
#
# `pnpm -r publish` has been observed to exit 0 having pushed SEVEN of twelve packages, printing no
# error and skipping the rest silently: core, open-verification, browser, react and vite-plugin never
# ran prepack at all. The registry was then left in the worst possible shape, with `server@3.0.0`
# depending on a `core@3.0.0` that was not there, so every install off it died on E404 while this
# script had already said "Published". A publish that half-happened is worse than one that failed,
# because only the failure is visible.
#
# WHY pnpm skips them is NOT known. It reported no error, ran no prepack for any of the six, and all
# six are in the workspace (`pnpm -r list` shows them), share the publishConfig of the ones that
# succeeded, and have no local .npmrc. Probing it by hand is harder than it looks: the user-creation
# curl above returns an EMPTY token when the account already exists, so a hand-run `pnpm publish`
# fails ENEEDAUTH for a reason that has nothing to do with the package under test. Two diagnoses were
# thrown away that way. So this verifies the OUTCOME rather than trying to police the cause.
echo ""
echo "==> Verifying every publishable package actually landed"
MISSING=$(node -e '
const { execFileSync } = require("child_process");
const { readFileSync } = require("fs");
const reg = process.argv[1];
const files = execFileSync("git", ["ls-files", "*package.json"], { encoding: "utf8" })
  .split("\n")
  .filter((f) => f && !f.includes("node_modules") && !f.startsWith("apps/"));
const want = [];
for (const f of files) {
  let m;
  try { m = JSON.parse(readFileSync(f, "utf8")); } catch { continue; }
  // Publishable is "not private", NOT "in our scope". `open-verification` left the org and would
  // have been invisible here the moment it did, which is precisely the blind spot this check exists
  // to close.
  if (!m.name || m.private === true) continue;
  want.push([m.name, m.version]);
}
const missing = [];
for (const [name, version] of want) {
  let body = "";
  try {
    body = execFileSync("curl", ["-fsS", `${reg}/${name.replace("/", "%2f")}`], { encoding: "utf8" });
  } catch { missing.push(`${name}@${version} (not on the registry at all)`); continue; }
  let doc;
  try { doc = JSON.parse(body); } catch { missing.push(`${name}@${version} (unreadable metadata)`); continue; }
  if (!doc.versions || !doc.versions[version]) missing.push(`${name}@${version}`);
}
process.stdout.write(missing.join("\n"));
' "${REG}")

if [ -n "${MISSING}" ]; then
  echo ""
  echo "✗ PUBLISH INCOMPLETE. These are missing from ${REG}:"
  echo "${MISSING}" | sed 's/^/    /'
  echo ""
  echo "  Anything installing from this registry will fail on a transitive dependency."
  echo "  Re-run this script; if a package keeps being skipped, run its own prepack by hand to see why."
  exit 1
fi
echo "    all publishable packages present"

echo ""
echo "✅ Published @reticlehq/* to ${REG}"
echo ""
echo "In your external app:"
echo "  echo '@reticlehq:registry=${REG}' >> .npmrc"
echo "  npm i -D @reticlehq/browser @reticlehq/react @reticlehq/next   # + @reticlehq/babel-plugin for non-Next"
echo "  npx --registry ${REG} @reticlehq/server              # run the bridge + MCP server"
