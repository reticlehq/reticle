#!/usr/bin/env node
// Dependency-boundary guard for the Reticle monorepo.
//
// Enforces the CLAUDE.md service-boundary invariant mechanically, so a browser-side package can
// never again drag in the Node MCP server + `ws` (the mistake that made `@reticlehq/core` a
// top-of-graph umbrella). Runs over the workspace `package.json` graph — no build, no new dependency.
//
// The rule, in one line: the browser side and the Node side must not import each other, and the
// browser side must not import Node-only externals. Isomorphic foundation packages may be imported
// by anyone but may import neither side.
//
// Usage:
//   node scripts/check-boundaries.mjs            # check the real workspace; exit 1 on any violation
//   node scripts/check-boundaries.mjs --self-test # verify the checker itself catches a bad graph
//
// Wired into `pnpm lint` and CI so a regression fails the build. To add a new package, tag it in
// `SIDE` below; an untagged package is treated as isomorphic and is checked accordingly.

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGES_DIR = join(HERE, '..', 'packages');

/** Which side of the browser/Node line each package lives on. Untagged → 'iso' (isomorphic). */
export const SIDE = Object.freeze({
  // Browser side — runs in the page, touches the DOM, never Node.
  '@reticlehq/browser': 'browser',
  '@reticlehq/react': 'browser',
  '@reticlehq/next': 'browser',
  '@reticlehq/vite-plugin': 'browser',
  '@reticlehq/babel-plugin': 'browser',
  '@reticlehq/eslint-plugin': 'browser',
  // Node side — runs in the `reticle` process, touches sockets/fs, never the DOM.
  '@reticlehq/server': 'node',
  '@reticlehq/test': 'node',
  // Isomorphic foundation — imported by both sides, imports neither.
  '@reticlehq/core': 'iso',
  '@reticlehq/protocol': 'iso',
});

/** Node-only npm packages a browser-side package must never depend on (a proxy for "needs Node"). */
export const NODE_ONLY_EXTERNALS = Object.freeze([
  'ws',
  '@modelcontextprotocol/sdk',
  'playwright',
  'express',
]);

/** DOM-only npm packages a Node-side package must never depend on. */
export const DOM_ONLY_EXTERNALS = Object.freeze(['@testing-library/dom']);

// No exemptions: `@reticlehq/core` is now the isomorphic, zod-only foundation, so it is guarded like
// any other package. (It was briefly exempt while it was still the umbrella being inverted.)
export const EXEMPT = Object.freeze(new Set());

/** The side a package may not depend on. Iso may depend on neither side (only other iso + zod). */
const FORBIDDEN_SIDE = Object.freeze({
  browser: 'node',
  node: 'browser',
  iso: 'either',
});

/**
 * Compute boundary violations for a set of package manifests.
 * @param {Array<{name: string, dependencies?: Record<string,string>, peerDependencies?: Record<string,string>}>} manifests
 * @param {Record<string,string>} side  Map of package name -> 'browser' | 'node' | 'iso'.
 * @returns {Array<{from: string, to: string, reason: string}>}
 */
export function findViolations(manifests, side = SIDE) {
  const sideOf = (name) => side[name] ?? 'iso';
  const violations = [];

  for (const pkg of manifests) {
    const from = pkg.name;
    if (EXEMPT.has(from)) continue;
    const fromSide = sideOf(from);
    const deps = { ...pkg.dependencies, ...pkg.peerDependencies };

    for (const dep of Object.keys(deps)) {
      const depSide = sideOf(dep);
      const isWorkspacePkg = dep.startsWith('@reticlehq/');

      // 1. Cross-side workspace edges: browser<->node, and iso->either-side.
      if (isWorkspacePkg) {
        if (fromSide === 'iso' && depSide !== 'iso') {
          violations.push({
            from,
            to: dep,
            reason: `isomorphic package must not depend on the ${depSide} side`,
          });
        } else if (FORBIDDEN_SIDE[fromSide] === depSide) {
          violations.push({
            from,
            to: dep,
            reason: `${fromSide}-side package must not depend on the ${depSide} side`,
          });
        }
        continue;
      }

      // 2. Node-only externals on a browser-side (or iso) package.
      if ((fromSide === 'browser' || fromSide === 'iso') && NODE_ONLY_EXTERNALS.includes(dep)) {
        violations.push({
          from,
          to: dep,
          reason: `${fromSide}-side package must not depend on the Node-only external "${dep}"`,
        });
      }

      // 3. DOM-only externals on a Node-side (or iso) package.
      if ((fromSide === 'node' || fromSide === 'iso') && DOM_ONLY_EXTERNALS.includes(dep)) {
        violations.push({
          from,
          to: dep,
          reason: `${fromSide}-side package must not depend on the DOM-only external "${dep}"`,
        });
      }
    }
  }

  return violations;
}

/** Read every package.json manifest under the given packages directory. */
function readManifests(packagesDir) {
  return readdirSync(packagesDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => join(packagesDir, e.name, 'package.json'))
    .map((p) => JSON.parse(readFileSync(p, 'utf8')));
}

/** In-memory proof that the checker catches a real violation — the ONE runnable check. */
function selfTest() {
  const bad = [
    { name: '@reticlehq/browser', dependencies: { ws: '^8', '@reticlehq/server': 'workspace:*' } },
    { name: '@reticlehq/server', dependencies: { '@reticlehq/react': 'workspace:*' } },
    { name: '@reticlehq/protocol', dependencies: { '@reticlehq/browser': 'workspace:*' } },
  ];
  const v = findViolations(bad);
  const got = new Set(v.map((x) => `${x.from}->${x.to}`));
  const expected = [
    '@reticlehq/browser->ws',
    '@reticlehq/browser->@reticlehq/server',
    '@reticlehq/server->@reticlehq/react',
    '@reticlehq/protocol->@reticlehq/browser',
  ];
  const missing = expected.filter((e) => !got.has(e));
  if (missing.length > 0) {
    console.error('self-test FAILED — checker missed:', missing.join(', '));
    process.exit(1);
  }
  console.log('boundary checker self-test passed (%d synthetic violations caught)', v.length);
}

function main() {
  if (process.argv.includes('--self-test')) {
    selfTest();
    return;
  }
  const violations = findViolations(readManifests(PACKAGES_DIR));
  if (violations.length > 0) {
    console.error('Dependency-boundary violations:\n');
    for (const v of violations) console.error(`  ✗ ${v.from} → ${v.to}\n    ${v.reason}`);
    console.error(`\n${violations.length} violation(s). See scripts/check-boundaries.mjs.`);
    process.exit(1);
  }
  console.log(
    'Dependency boundaries OK (%d packages checked).',
    readManifests(PACKAGES_DIR).length,
  );
}

// Only run when invoked directly, not when imported by a test.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
