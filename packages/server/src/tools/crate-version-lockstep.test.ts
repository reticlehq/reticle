/**
 * The Rust crate must ship the version everything else ships.
 *
 * `reticle-tauri` sat at `0.1.0` from the day it was written on 2026-08-02 until 2.11.0. Nothing
 * bumped it, and `publish-crate.yml` publishes only when the version is ABSENT from crates.io — so
 * every release in the 2.x line ran that job, found `0.1.0` already there, printed "nothing to do",
 * and exited successfully. A silent no-op reporting green, on every release, for months.
 *
 * The cost was not theoretical. `d09cd5c6` moved desktop captures out of the shared OS temp
 * directory, where they were written under a name any local process could work out — a public
 * prefix, a readable pid, and a counter starting at zero. That fix merged on 2026-08-13 and reached
 * nobody, because the only published crate was the one from before it, and the docs told users to
 * pin `reticle-tauri = "0.1"`, which resolves to exactly that build.
 *
 * The docs called this "versioned independently — deliberate, not drift". True as written and false
 * in effect: it was not versioned, it was stuck.
 *
 * So the crate moves in lockstep, and this is what makes lockstep a fact rather than an intention.
 * A release that bumps the eleven npm packages and forgets the twelfth artifact now fails here, in the
 * fast unit gate, instead of silently shipping nothing.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SERVER_VERSION } from '../version/server-version.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const CARGO = join(REPO, 'adapters', 'realm', 'tauri', 'Cargo.toml');

/** The `version = "x.y.z"` of the `[package]` table — the first one in the file. */
function crateVersion(source: string): string | undefined {
  return /^version\s*=\s*"([^"]+)"/m.exec(source)?.[1];
}

describe('the Rust crate ships the version everything else ships', () => {
  it('reads a version out of Cargo.toml at all', () => {
    // Guards the guard: a regex that stopped matching would make every assertion below vacuous, and
    // this file exists precisely because a check that quietly passes is worse than no check.
    expect(crateVersion(readFileSync(CARGO, 'utf8'))).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('is in lockstep with the npm packages', () => {
    expect(
      crateVersion(readFileSync(CARGO, 'utf8')),
      'adapters/realm/tauri/Cargo.toml is behind the release. A version already on crates.io is SKIPPED by ' +
        'publish-crate.yml, which then reports success — so forgetting this ships nothing and says ' +
        'it worked. Bump it with the npm packages.',
    ).toBe(SERVER_VERSION);
  });

  it('parses the package version, not a dependency pinned in the same file', () => {
    // `[dependencies]` entries carry their own `version = "…"`. Anchoring to the first match works
    // only while `[package]` is first; if that ever stops being true this test should say so rather
    // than silently compare a dependency's version to ours.
    const source = readFileSync(CARGO, 'utf8');
    expect(source.indexOf('[package]')).toBeLessThan(source.indexOf('version'));
  });
});

describe('the docs pin a crate version that exists', () => {
  const pinned = (file: string): string[] => {
    const source = readFileSync(join(REPO, 'docs', file), 'utf8');
    return [...source.matchAll(/reticle-tauri\s*=\s*"([^"]+)"/g)].map((m) => m[1] ?? '');
  };

  it.each(['desktop.mdx', 'install-manual.mdx', 'packages.mdx'])(
    '%s pins a version this release actually publishes',
    (file) => {
      const [major, minor] = SERVER_VERSION.split('.');
      for (const pin of pinned(file)) {
        // A caret pin of `major.minor` resolves to this release's patches. A pin naming a
        // major.minor we do not publish resolves to whatever was last there — which is how users
        // stayed on a build with a known capture-path defect for months.
        expect(pin, `${file} pins reticle-tauri = "${pin}"`).toBe(`${major}.${minor}`);
      }
    },
  );
});
