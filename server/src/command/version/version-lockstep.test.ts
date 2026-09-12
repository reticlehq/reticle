import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RETICLE_NPM_PACKAGE, RETICLE_VERSION } from '@reticlehq/init';
import { SERVER_VERSION } from './identity/server-version.js';
import { REPO_ROOT } from '../../machine/repo-root.js';

/**
 * The scaffolder and the daemon must agree about what they are.
 *
 * `@reticlehq/init` reads its OWN package.json for the version it stamps into generated snippets —
 * the CDN recipe pins `@reticlehq/browser@<that>` — and hard-codes `@reticlehq/server` as the
 * package that carries the `reticle` bin, because its own name has no bin and telling a user to
 * `npx @reticlehq/init` installs something they cannot run.
 *
 * Both facts were free while the two were one package: the version came from one manifest and the
 * name was read off it. Splitting them turns each into an assumption, and an assumption about a
 * version is the class of thing that shipped a Rust crate stuck at `0.1.0` for four months while
 * every release reported success. So they are checked here, in the fast gate, against the manifests
 * themselves rather than against each other's constants — a guard that reads the same source twice
 * proves nothing.
 */
const REPO = REPO_ROOT;

const manifest = (pkg: string): { name?: string; version?: string } =>
  JSON.parse(readFileSync(join(REPO, pkg, 'package.json'), 'utf8')) as {
    name?: string;
    version?: string;
  };

describe('the scaffolder ships in lockstep with the daemon', () => {
  it('reads a version out of both manifests at all', () => {
    // Guards the guard: two undefineds compare equal, and this file exists precisely because a check
    // that quietly passes is worse than no check.
    expect(manifest('init').version).toMatch(/^\d+\.\d+\.\d+/);
    expect(manifest('server').version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('stamps the version the daemon ships', () => {
    expect(
      RETICLE_VERSION,
      'init/package.json is behind the release. Every generated snippet pins the SDK at ' +
        'this version, so a stale one hands users an SDK that does not match their daemon. ' +
        '`node scripts/set-version.mjs <v>` writes both.',
    ).toBe(SERVER_VERSION);
    expect(manifest('init').version).toBe(manifest('server').version);
  });

  it('names the package that actually carries the `reticle` bin', () => {
    // Read off the server's manifest, not off SERVER_VERSION's sibling constant: the point is that
    // the scaffolder's hard-coded string still matches the package it is naming.
    expect(
      RETICLE_NPM_PACKAGE,
      'the scaffolder tells users and agents to run this package. It must be the one with the bin.',
    ).toBe(manifest('server').name);
  });
});
