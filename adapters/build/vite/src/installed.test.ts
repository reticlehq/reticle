import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isResolvable,
  resolvableChain,
  sdkPackageVersion,
  sdkBuildFingerprint,
} from './installed.js';

const SDK_PACKAGE = '@reticlehq/react';
const FAKE_SDK_VERSION = '9.9.9';
const NOT_INSTALLED_FINGERPRINT = 'unknown';
/** A specifier no node_modules anywhere on the walk-up can contain. */
const ABSENT_PACKAGE = '@reticlehq/definitely-not-a-real-package';

/**
 * A minimal app tree: the SDK under the app's own node_modules, and nothing else.
 *
 * This is the shape that mattered. All three probes used to resolve from the PLUGIN's location, so
 * under pnpm's strict layout — where the SDK is the user's dependency and not the plugin's — every
 * one of them fell into its catch and returned the "not installed" answer for an app that had the
 * SDK installed. Nothing threw; the HELLO just carried no version, the fingerprint was a constant
 * (so a changed SDK never invalidated Vite's pre-bundle), and the SDK was left out of optimizeDeps.
 */
function makeAppWithSdk(): string {
  const root = mkdtempSync(join(tmpdir(), 'reticle-installed-'));
  const pkgDir = join(root, 'node_modules', SDK_PACKAGE);
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(join(pkgDir, 'index.js'), 'module.exports = {};');
  writeFileSync(
    join(pkgDir, 'package.json'),
    JSON.stringify({ name: SDK_PACKAGE, version: FAKE_SDK_VERSION, main: './index.js' }),
  );
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'app', version: '0.0.0' }));
  return root;
}

/**
 * An app whose dependency chain is nested rather than flat: the app can see only the first package,
 * which carries the second, which carries the third. Node resolves this identically to pnpm's
 * symlinked store, and it is what every pnpm install of Reticle looks like.
 *
 * The names are invented rather than real package names on purpose. Node resolution walks
 * node_modules UPWARD and this suite runs inside the monorepo, so a temp dir asking for a real
 * workspace dependency can accidentally find this repo's copy and make the "the app cannot see it"
 * precondition quietly become false.
 */
const NESTED_CHAIN = [
  '@reticle-fixture/outer',
  '@reticle-fixture/middle',
  '@reticle-fixture/leaf',
] as const;

function makeAppWithNestedCjsDep(): string {
  const root = mkdtempSync(join(tmpdir(), 'reticle-nested-'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'app', version: '0.0.0' }));
  let dir = root;
  for (const name of NESTED_CHAIN) {
    dir = join(dir, 'node_modules', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'index.js'), 'module.exports = {};');
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name, version: FAKE_SDK_VERSION, main: './index.js' }),
    );
  }
  return root;
}

describe('installed — probes resolve from the app root, not from this plugin', () => {
  let appRoot: string;
  let emptyRoot: string;

  beforeAll(() => {
    appRoot = makeAppWithSdk();
    emptyRoot = mkdtempSync(join(tmpdir(), 'reticle-empty-'));
    writeFileSync(join(emptyRoot, 'package.json'), JSON.stringify({ name: 'empty' }));
  });
  afterAll(() => {
    rmSync(appRoot, { recursive: true, force: true });
    rmSync(emptyRoot, { recursive: true, force: true });
  });

  it('reads the version from the SDK installed in the app', () => {
    expect(sdkPackageVersion(appRoot)).toBe(FAKE_SDK_VERSION);
  });

  it('reports the SDK as resolvable from the app', () => {
    expect(isResolvable(SDK_PACKAGE, appRoot)).toBe(true);
  });

  it('fingerprints the SDK build found in the app', () => {
    expect(sdkBuildFingerprint(appRoot)).not.toBe(NOT_INSTALLED_FINGERPRINT);
  });

  it('says false rather than guessing for a package nobody has', () => {
    expect(isResolvable(ABSENT_PACKAGE, appRoot)).toBe(false);
    expect(isResolvable(ABSENT_PACKAGE, emptyRoot)).toBe(false);
  });

  /**
   * A dependency can be reachable only through a parent package. The helper reports the Vite chain
   * spelling for that generic case, even though this PR no longer uses it for browser query-engine
   * deps.
   */
  it('spells a dep the app cannot resolve as the nested chain that reaches it', () => {
    const nested = makeAppWithNestedCjsDep();
    const [outer, middle, leaf] = NESTED_CHAIN;
    try {
      expect(isResolvable(leaf, nested), 'precondition: the app root itself cannot see it').toBe(
        false,
      );
      expect(resolvableChain([outer, middle, leaf], nested)).toBe(`${outer} > ${middle} > ${leaf}`);
    } finally {
      rmSync(nested, { recursive: true, force: true });
    }
  });

  it('returns null for a chain that breaks anywhere along it, rather than a half-truth', () => {
    const nested = makeAppWithNestedCjsDep();
    const [outer, middle, leaf] = NESTED_CHAIN;
    try {
      expect(resolvableChain([outer, middle, ABSENT_PACKAGE], nested)).toBeNull();
      expect(resolvableChain([ABSENT_PACKAGE, leaf], nested)).toBeNull();
      // The leaf is only reachable THROUGH the middle — naming it one segment short must fail.
      expect(resolvableChain([outer, leaf], nested)).toBeNull();
    } finally {
      rmSync(nested, { recursive: true, force: true });
    }
  });

  it('prefers the bare specifier when the app really does have the package itself', () => {
    expect(resolvableChain([SDK_PACKAGE], appRoot)).toBe(SDK_PACKAGE);
  });

  // Not asserted here: sdkPackageVersion/sdkBuildFingerprint against an SDK-less root. Node walks
  // node_modules UPWARD, and this suite runs inside the monorepo, so any temp dir eventually reaches
  // the workspace's own @reticlehq/react and legitimately finds 2.4.1. The absent-package case above
  // covers the same "report nothing rather than guess" branch without lying about the environment.
});
