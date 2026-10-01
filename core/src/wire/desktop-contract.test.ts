import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { DESKTOP_CONTRACT } from './desktop-contract.js';
import { renderDesktopContract } from '../../scripts/gen-desktop-contract.mjs';
import { execFileSync } from 'node:child_process';

/**
 * Where the Rust crate's source is.
 *
 * Asked rather than counted: walking up a fixed number of directories is a statement about how deep
 * this package happens to sit, and the crate has just moved to sit with the other adapters. Git
 * already knows where the repository starts.
 */
const CRATE_SRC = join(
  execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim(),
  'adapters',
  'realm',
  'tauri',
  'src',
);

/**
 * The desktop contract has to hold across module systems that cannot import each other: a CommonJS
 * Electron preload, the ESM renderer SDK, and the Node daemon. It used to hold because six files
 * hand-copied the same strings, and a rename in any one broke desktop silently.
 *
 * Now the CommonJS view is GENERATED from the TypeScript source, so drift is not something to police
 * — it is impossible by construction. What is still worth asserting is that the generator stays
 * honest and that the committed build output is current.
 */
describe('desktop contract generation', () => {
  it('renders every exported constant into the CommonJS view', () => {
    const rendered = renderDesktopContract(DESKTOP_CONTRACT);
    for (const [name, value] of Object.entries(DESKTOP_CONTRACT)) {
      expect(rendered, `${name} must reach the CJS side`).toContain(name);
      expect(rendered, `${name}'s value must reach the CJS side`).toContain(JSON.stringify(value));
    }
  });

  it('renders a module a CommonJS preload can actually require', () => {
    const rendered = renderDesktopContract({ EXAMPLE: 'value' });
    expect(rendered).toContain("'use strict'");
    expect(rendered).toContain('exports.EXAMPLE');
    // Frozen so a misbehaving app cannot mutate the contract out from under the SDK.
    expect(rendered).toContain('Object.freeze(exports)');
  });

  it('marks the output as generated so nobody hand-edits it', () => {
    expect(renderDesktopContract(DESKTOP_CONTRACT)).toMatch(/GENERATED/);
  });

  /**
   * Catches the two failures the generator cannot prevent: a constant changed in source and the
   * package published without rebuilding, and the generator not running at all.
   *
   * The skip is keyed on `dist/` rather than on the CJS file itself, and that distinction is the
   * whole test. Skipping when the OUTPUT is absent cannot tell "nobody has built yet" from "the
   * build ran and silently produced nothing" — and the second is exactly what happened: the
   * generator's CLI-entry guard compared `import.meta.url` against a hand-concatenated
   * `file://${process.argv[1]}`, which never matches on Windows, so `pnpm build` reported success
   * while writing no CJS view at all. Every Electron app built there died at boot on a missing
   * module, and this test passed the whole time.
   */
  it('has a built CJS view matching the current source', () => {
    const dist = join(process.cwd(), 'dist');
    if (!existsSync(dist)) return; // genuinely un-built tree — there is nothing to compare yet
    const built = join(dist, 'desktop-contract.cjs');
    expect(
      existsSync(built),
      'dist exists but the generated CJS contract does not — the generator did not run. An ' +
        'Electron main process requires this file at boot; without it desktop support is dead.',
    ).toBe(true);
    expect(readFileSync(built, 'utf8')).toBe(renderDesktopContract(DESKTOP_CONTRACT));
  });
});

/**
 * The Rust side of the contract, which no generator can reach.
 *
 * `reticle-tauri` writes the capture file and the daemon decides whether to read it, and the two
 * agree only on a shared filename prefix. They are in different languages and different build
 * systems, so nothing but this test stands between a rename here and screenshots that go on being
 * written while the daemon silently refuses every one of them.
 */
describe('desktop contract — the Rust capture helper', () => {
  const CRATE = join(CRATE_SRC, 'capture.rs');
  const LIB = join(CRATE_SRC, 'lib.rs');

  /**
   * Read a crate file, or FAIL naming it.
   *
   * Every check below used to open with `if (!existsSync(x)) return;`, which turned "the file moved"
   * into "nothing to check" — five tests passing on an empty room. That is not hypothetical: the
   * crate moved to `adapters/realm/tauri` and the whole describe went quiet until `CRATE_SRC` was
   * re-derived. These files are tracked, so a clone always has them and an absence is a defect in
   * this guard's idea of where they live — which is exactly what it must say out loud.
   */
  const crateSource = (path: string): string => {
    expect(existsSync(path), `${path} is missing — the crate moved and CRATE_SRC did not`).toBe(
      true,
    );
    return readFileSync(path, 'utf8');
  };

  it('spells the capture prefix exactly as the daemon requires', () => {
    const source = crateSource(CRATE);
    expect(source).toContain(`{CAPTURE_FILE_PREFIX}`);
  });

  it('defines that prefix as the value the daemon checks for', () => {
    expect(crateSource(LIB)).toContain(
      `const CAPTURE_FILE_PREFIX: &str = "${DESKTOP_CONTRACT.RETICLE_CAPTURE_FILE_PREFIX}";`,
    );
  });

  it('spells the full-page refusal exactly as the daemon reads it', () => {
    expect(crateSource(LIB)).toContain(
      `pub const FULL_PAGE_UNSUPPORTED: &str = "${DESKTOP_CONTRACT.RETICLE_FULL_PAGE_UNSUPPORTED}";`,
    );
  });

  it('registers the command name the SDK invokes', () => {
    const capture = crateSource(CRATE);
    expect(capture).toContain(`pub async fn ${DESKTOP_CONTRACT.RETICLE_TAURI_CAPTURE_COMMAND}(`);
  });

  // Headless visibility, idle command response, and captures are exercised against the packaged
  // app by tauri-desktop-test.mjs. A source-text check forbidding hide() pinned the old workaround
  // while allowing an interactive window to remain visible on macOS.
});
