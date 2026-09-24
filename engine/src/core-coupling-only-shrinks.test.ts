/**
 * What this package borrows from `@reticlehq/core` may go down. It may not go up.
 *
 * `the-rules-stand-alone.test.ts` next door proves the rules no longer reach into the SERVER. This
 * is the same question asked about the next dependency out, and the answer today is "quite a lot":
 * 41 of 59 shipped files import core, for 54 distinct symbols.
 *
 * That is not an accident to be shamed, it is where the extraction stopped. The intent for this
 * package is that anyone implementing the Open Verification Protocol gets an engine with it — the
 * reasoning, free, for any domain. It cannot be that while it reads Reticle's own event union:
 * `EventType` and `ReticleEvent` alone are 105 of the 137 import sites, and a third party adopting
 * this would be taking on a browser contract to reason about a service, a game or a mobile app.
 *
 * `open-verification` already has the abstraction that fixes it — `Realm` in `spi/realm.ts`, the
 * thing a domain implements to supply evidence. This package references it zero times.
 *
 * So the work is real and it is not small, and the danger while it waits is not the debt: it is the
 * debt QUIETLY GROWING. Every new rule written against a Reticle noun is another site to unpick,
 * and nothing was counting. This counts. It fails when the number goes up, which is the only
 * failure that matters — a decoupling nobody has time for this month still finishes eventually if
 * it never runs backwards.
 *
 * Lower a ceiling when you lower the coupling. Raising one is the thing to argue about in a review,
 * which is the entire point of writing it down.
 *
 * The incident is this release: `@reticlehq/engine` was published under a vendor scope because it
 * could not honestly be published under the protocol's, and that gap had never been measured.
 */

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Ceilings, not targets. Measured 2026-09-18 over shipped (non-test) sources. */
/*
 * Raised 41 -> 43, and the two are NOT the same kind of change.
 *
 * `predicate-state.ts` is a SPLIT, not new coupling. `predicate.ts` crossed the 1000-line cap while
 * the predicate language was gaining its past tense, and rule 6 says split before adding. The state
 * evaluator moved out whole: the same symbols, from the same package, on the same code path. The
 * file count is a PROXY for the coupling, and a proxy that forbids obeying another rule in the same
 * file is measuring the wrong thing here. Counting import SITES — which the symbol ceiling below
 * effectively does, and which did not move — is the honest reading of this one.
 *
 * `evidence/baseline.ts` is a real +1 and gets no such defence. It reads `STATE_READ` and `MATCH`,
 * which are wire command names, and those live in core by the rule that put them there. The
 * alternative was inlining two wire strings in the engine, which keeps this number flat by breaking
 * the rule it exists to protect — the same argument as the symbol raise below it.
 *
 * Both are the debt the header describes, and neither is the debt growing quietly: the answer is
 * still `Realm`, and this file is still the thing that stops it running backwards.
 */
const MAX_FILES_IMPORTING_CORE = 43;
/**
 * Raised by one, deliberately, and this is the argument for it.
 *
 * `duplicate-request` fired on legitimate sequential writes because method plus URL cannot tell two
 * different payloads apart, and the field that can — the page's body-shape fingerprint — is a name
 * that crosses the wire, so it belongs in core and nowhere else. Inlining the string in the rule
 * would have kept this number flat by breaking the rule the number exists to protect.
 *
 * It is one more symbol on the SAME file that already imports core, so the file count is unmoved.
 * A realm-shaped engine takes the request's identity from the realm, and this goes with the rest.
 */
const MAX_DISTINCT_SYMBOLS = 55;

/*
 * `node:path`'s dirname, not a hand-rolled one.
 *
 * This file shipped with `p.slice(0, p.lastIndexOf('/'))`, which is POSIX-only: on Windows
 * `fileURLToPath` hands back `D:\a\...\engine\src\<file>.ts`, there is no `/` in it, and the
 * whole expression collapses to `''`. `PACKAGE_ROOT` became `..`, `git ls-files` ran somewhere else
 * and returned nothing, and every ceiling below passed over an empty list. The `windows` CI job
 * caught it on the first run -- via the two negative controls in this file, which is the entire
 * reason they are here.
 */
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Shipped sources only: a test may lean on core to build a fixture without binding the product. */
function shippedSources(): string[] {
  const out = execFileSync('git', ['ls-files', 'src/**/*.ts'], {
    cwd: PACKAGE_ROOT,
    encoding: 'utf8',
  });
  return out.split('\n').filter((f) => f.length > 0 && !f.includes('.test.'));
}

interface Coupling {
  readonly files: number;
  readonly symbols: ReadonlySet<string>;
}

function couplingToCore(): Coupling {
  const symbols = new Set<string>();
  let files = 0;
  for (const rel of shippedSources()) {
    const text = readFileSync(join(PACKAGE_ROOT, rel), 'utf8');
    const statements = text.match(/import[^;]*from '@reticlehq\/core'/g) ?? [];
    if (0 === statements.length) continue;
    files += 1;
    for (const statement of statements) {
      const braced = /\{([^}]*)\}/.exec(statement);
      if (null === braced) continue;
      for (const raw of (braced[1] ?? '').split(',')) {
        const name = raw.replace(/\btype\b/, '').trim();
        if ('' !== name) symbols.add(name);
      }
    }
  }
  return { files, symbols };
}

describe('what the engine borrows from @reticlehq/core', () => {
  it('finds the sources at all, so a ceiling cannot pass over an empty list', () => {
    // The negative control. `git ls-files` run from the wrong directory returns nothing, and every
    // assertion below would then pass by measuring no code whatsoever.
    expect(shippedSources().length).toBeGreaterThan(30);
  });

  it('still matches real imports, so the regex has not silently stopped matching', () => {
    // The other way this goes vacuous: a formatting change to how imports are written would drop
    // the count to zero and read as a finished decoupling.
    const { files, symbols } = couplingToCore();
    expect(files).toBeGreaterThan(0);
    expect(symbols.size).toBeGreaterThan(0);
  });

  it('does not spread to more files than it already reaches', () => {
    const { files } = couplingToCore();
    expect(
      files,
      `${String(files)} shipped engine files import @reticlehq/core, ceiling ${String(MAX_FILES_IMPORTING_CORE)}. ` +
        'If you lowered it, lower the ceiling in this file. If you raised it, that is the decoupling ' +
        'running backwards — the protocol cannot ship an engine that needs a browser contract.',
    ).toBeLessThanOrEqual(MAX_FILES_IMPORTING_CORE);
  });

  it('does not borrow more distinct symbols than it already borrows', () => {
    const { symbols } = couplingToCore();
    expect(
      symbols.size,
      `engine borrows ${String(symbols.size)} distinct symbols from @reticlehq/core, ceiling ` +
        `${String(MAX_DISTINCT_SYMBOLS)}. A NEW name here is a new thing to unpick later: prefer ` +
        'expressing the rule over the protocol vocabulary in `open-verification`.',
    ).toBeLessThanOrEqual(MAX_DISTINCT_SYMBOLS);
  });
});
