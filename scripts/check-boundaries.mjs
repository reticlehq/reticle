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
// `SIDE` below. An untagged package with a manifest is a VIOLATION, not a default.
//
// It used to be treated as isomorphic, and that default is the one hole a boundary guard cannot
// afford. Isomorphic is the most permissive side there is: everyone may import it. So a Node package
// nobody remembered to tag was silently declared safe for the browser side to depend on, which is
// the exact edge this file exists to forbid. It also cut the other way, since an untagged Node
// package inherits the iso policy and is refused the Node externals it legitimately needs.
//
// `@reticlehq/electron` had been sitting in that gap. A Rust crate with no package.json is still not
// an error: `readManifests` never sees it, so `adapters/realm/tauri` needs no tag.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..');

/**
 * Which runtime each package lives in. Untagged → 'iso' (isomorphic). Four sides, because a build
 * plugin is neither the browser runtime nor the server runtime — it is a Node process that runs at
 * *build* time. Collapsing it into 'browser' would be a lie (it uses `node:fs`); collapsing it into
 * 'node' would let it pull the server runtime. It gets its own side.
 */
export const SIDE = Object.freeze({
  // Browser runtime — runs in the page, touches the DOM, never Node.
  '@reticlehq/browser': 'browser',
  '@reticlehq/react': 'browser',
  // Build-time Node tooling — source-mapping plugins + lint rule. Uses Node at build time, but must
  // not pull the browser/server *runtime* packages or a WS/MCP/DOM dependency.
  '@reticlehq/next': 'build',
  '@reticlehq/vite-plugin': 'build',
  '@reticlehq/babel-plugin': 'build',
  '@reticlehq/eslint-plugin': 'build',
  // Server runtime — runs in the `reticle` process, touches sockets/fs, never the DOM.
  '@reticlehq/server': 'node',
  '@reticlehq/test': 'node',
  // The project scaffolder. Build-time by nature — it edits configs and shells out to a package
  // manager — but tagged 'node' rather than 'build' because @reticlehq/server depends on it, and a
  // node-side package may only reach the node side and the isomorphic foundation. It carries no
  // WS/MCP/DOM dependency of its own, which is the substance the 'build' tag exists to protect.
  '@reticlehq/init': 'node',
  // The Electron adapter is Node on both halves: `main.cjs` requires `electron`'s ipcMain and
  // `node:fs/promises`, and the preload shim runs in the preload context, which has Node integration
  // and never touches `document` or `window`. It is not the browser side, and it is not isomorphic.
  '@reticlehq/electron': 'node',
  // Isomorphic foundation — imported by every side, imports none of them.
  '@reticlehq/core': 'iso',
  // The conformance suite. Isomorphic and dependency-free: it describes behaviours to plant and
  // scores what came back, and does neither in a browser nor a daemon.
  '@reticlehq/conformance': 'iso',
  // The rules that decide a verdict. Isomorphic: they read what happened and answer a question about
  // it, which needs neither a page nor a socket. That is the whole reason they can be lifted out of
  // the daemon and used on their own.
  '@reticlehq/engine': 'iso',
  // The specification. Isomorphic for the same reason core is, and stricter in practice: it has no
  // dependencies at all, because a contract that needs a library to read is a contract with a
  // dependency somebody else has to accept.
  '@reticlehq/openreality': 'iso',
});

/** Node-runtime npm packages a browser/build/iso package must never depend on (a "needs a server" proxy). */
export const NODE_ONLY_EXTERNALS = Object.freeze([
  'ws',
  '@modelcontextprotocol/sdk',
  'playwright',
  'express',
]);

/** DOM-only npm packages a Node/build/iso package must never depend on. */
export const DOM_ONLY_EXTERNALS = Object.freeze(['@testing-library/dom']);

// No exemptions: `@reticlehq/core` is now the isomorphic, zod-only foundation, so it is guarded like
// any other package. (It was briefly exempt while it was still the umbrella being inverted.)
export const EXEMPT = Object.freeze(new Set());

/**
 * The policy for each side: which sides its workspace deps may point at, and which external packages
 * it may never depend on. A side may always depend on itself and on the isomorphic foundation.
 */
const POLICY = Object.freeze({
  iso: { allow: ['iso'], forbid: [...NODE_ONLY_EXTERNALS, ...DOM_ONLY_EXTERNALS] },
  browser: { allow: ['browser', 'iso'], forbid: NODE_ONLY_EXTERNALS },
  node: { allow: ['node', 'iso'], forbid: DOM_ONLY_EXTERNALS },
  build: { allow: ['build', 'iso'], forbid: [...NODE_ONLY_EXTERNALS, ...DOM_ONLY_EXTERNALS] },
});

/**
 * Compute boundary violations for a set of package manifests.
 * @param {Array<{name: string, dependencies?: Record<string,string>, peerDependencies?: Record<string,string>}>} manifests
 * @param {Record<string,string>} side  Map of package name -> 'browser' | 'build' | 'node' | 'iso'.
 * @returns {Array<{from: string, to: string, reason: string}>}
 */
export function findViolations(manifests, side = SIDE) {
  const sideOf = (name) => side[name] ?? 'iso';
  const violations = [];

  for (const pkg of manifests) {
    const from = pkg.name;
    if (EXEMPT.has(from)) continue;
    // Untagged is not a side, it is an unanswered question. Reported before the edges are walked,
    // because every judgement below depends on knowing which runtime this package is.
    if (!Object.hasOwn(side, from)) {
      violations.push({
        from,
        to: '',
        reason:
          'package is not tagged in SIDE — add it as browser, build, node or iso. Until it is, ' +
          'the guard cannot say which edges it may have, and an untagged package would default to ' +
          'the most permissive side (iso), which every other side is allowed to import',
      });
      continue;
    }
    const fromSide = sideOf(from);
    const policy = POLICY[fromSide];
    const deps = { ...pkg.dependencies, ...pkg.peerDependencies };

    for (const dep of Object.keys(deps)) {
      if (dep.startsWith('@reticlehq/')) {
        // Workspace edge: the dependency's side must be one this side is allowed to import.
        const depSide = sideOf(dep);
        if (!policy.allow.includes(depSide)) {
          violations.push({
            from,
            to: dep,
            reason: `${fromSide}-side package must not depend on the ${depSide} side`,
          });
        }
      } else if (policy.forbid.includes(dep)) {
        // External edge: a package on the wrong side of the runtime line.
        violations.push({
          from,
          to: dep,
          reason: `${fromSide}-side package must not depend on "${dep}"`,
        });
      }
    }
  }

  return violations;
}

/**
 * Where the packages are, taken from `pnpm-workspace.yaml`.
 *
 * This used to be a list of directories written out by hand here, and twice a package moved somewhere
 * the list did not mention. Both times the guard went on printing success about the packages it could
 * still see, which is worse than no guard at all -- a green then reads as "these are fine" when what
 * it means is "these were not looked at".
 *
 * The workspace file cannot go stale in the same way, because it is the list the package manager
 * itself installs from. A package missing from it is not quietly unchecked; it is not installed, and
 * everything that depends on it stops working loudly.
 *
 * The globs used here are simple by convention -- `name`, `dir/*`, `dir/*\/*` -- so they are expanded
 * directly rather than by pulling in a glob library for four shapes.
 */
export function workspaceGlobs(yamlText) {
  return [...yamlText.matchAll(/^\s*-\s*'([^']+)'/gm)].map((m) => m[1]);
}

/** Expand one glob to the directories it names, relative to the repo root. */
function directoriesFor(glob, root) {
  const [head, ...rest] = glob.split('/');
  const here = join(root, head ?? '');
  if (!existsSync(here)) return [];
  if (rest.length === 0) return [here];
  const children = readdirSync(here, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => join(here, e.name));
  if (rest.length === 1) return children;
  // Only one more level is ever used (`adapters/<kind>/<name>`), and it is expanded the same way.
  return children.flatMap((child) =>
    readdirSync(child, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => join(child, e.name)),
  );
}

/**
 * Read every package.json the workspace covers, skipping the local fixture apps.
 *
 * A directory without a manifest is not an error: `adapters/realm/tauri` is a Rust crate, which has a Cargo
 * manifest and no npm one. It has no JavaScript dependency edges, so there is nothing here to check.
 */
function readManifests(root = REPO_ROOT) {
  const globs = workspaceGlobs(readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8'))
    // Everything under `apps/` is a local fixture, never published, and deliberately allowed to
    // depend on anything at all -- that is what makes it a fixture.
    .filter((glob) => !glob.startsWith('apps'));
  return globs
    .flatMap((glob) => directoriesFor(glob, root))
    .map((dir) => join(dir, 'package.json'))
    .filter((p) => existsSync(p))
    .map((p) => JSON.parse(readFileSync(p, 'utf8')));
}

/** In-memory proof that the checker catches a real violation — the ONE runnable check. */
function selfTest() {
  const bad = [
    { name: '@reticlehq/browser', dependencies: { ws: '^8', '@reticlehq/server': 'workspace:*' } },
    { name: '@reticlehq/server', dependencies: { '@reticlehq/react': 'workspace:*' } },
    { name: '@reticlehq/core', dependencies: { '@reticlehq/browser': 'workspace:*' } },
    // A package nobody tagged. Its deps are deliberately innocent: the violation is the missing
    // answer, not an edge, and before this the guard read the silence as "isomorphic" and passed it.
    { name: '@reticlehq/untagged', dependencies: { '@reticlehq/core': 'workspace:*' } },
  ];
  const v = findViolations(bad);
  const got = new Set(v.map((x) => `${x.from}->${x.to}`));
  const expected = [
    '@reticlehq/browser->ws',
    '@reticlehq/browser->@reticlehq/server',
    '@reticlehq/server->@reticlehq/react',
    '@reticlehq/core->@reticlehq/browser',
    '@reticlehq/untagged->',
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
  const violations = findViolations(readManifests());
  if (violations.length > 0) {
    console.error('Dependency-boundary violations:\n');
    for (const v of violations) {
      // An untagged package has no edge to name, so printing "pkg → " would invent one.
      const edge = v.to === '' ? v.from : `${v.from} → ${v.to}`;
      console.error(`  ✗ ${edge}\n    ${v.reason}`);
    }
    console.error(`\n${violations.length} violation(s). See scripts/check-boundaries.mjs.`);
    process.exit(1);
  }
  console.log('Dependency boundaries OK (%d packages checked).', readManifests().length);
}

// Only run when invoked directly, not when imported by a test.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
