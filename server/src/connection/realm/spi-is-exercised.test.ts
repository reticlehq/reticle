import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every method the SPI obliges an implementation to write must be called by the suite that
 * scores it.
 *
 * A required method nobody calls is a tax with no check behind it: the compiler makes every
 * implementer write `describe`, and until this test existed the conformance binding never
 * invoked it, so an implementation could have thrown from it and still earned the `effect`
 * profile. That is the fifth instance this release of one shape -- `impeaching`, `predicate`,
 * `Ground` and `Handle` were the others -- where something was defined, deferred to somebody,
 * and reached by nobody.
 *
 * The rule is derived from the specification's source rather than from a list here, so adding an
 * `abstract` member to `Realm` fails this until the binding uses it. A list would need updating
 * by the same person who forgot the call.
 *
 * OPTIONAL members (`locate?`, `detect?`, `photograph?`) are deliberately out of scope: an
 * implementation is entitled not to have them, and the suite already handles their absence.
 */

const REPO = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  cwd: import.meta.dirname,
  encoding: 'utf8',
}).trim();

/** The abstract members of `Realm`, read from the specification itself. */
function requiredMembers(): string[] {
  const source = readFileSync(join(REPO, 'openreality/src/spi/realm.ts'), 'utf8');
  return [...source.matchAll(/^\s*(?:protected\s+)?abstract\s+([a-zA-Z]+)\s*\(/gm)]
    .map((m) => m[1] ?? '')
    .filter((name) => '' !== name)
    .sort();
}

/** The binding, with comments stripped: a call in prose is not a call. */
function bindingCode(): string {
  return readFileSync(join(REPO, 'server/src/connection/realm/conformance-client.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

describe('the conformance binding exercises everything the SPI requires', () => {
  it('reads the abstract members from the specification, and finds some', () => {
    // Without this, a regex that stopped matching would make every assertion below vacuous.
    const members = requiredMembers();
    expect(members.length).toBeGreaterThan(5);
    expect(members).toContain('describe');
  });

  it('calls each of them, or reaches it through the sealed wrapper', () => {
    const code = bindingCode();
    const unexercised = requiredMembers().filter((name) => {
      // `dispatch` is protected and unreachable by design: `perform` is the sealed entry point
      // that refuses an undeclared capability before dispatching, and calling dispatch directly
      // would skip exactly that check.
      if ('dispatch' === name) return !code.includes('.perform(');
      return !code.includes(`.${name}(`);
    });
    expect(
      unexercised,
      'these are required of every implementation and the conformance binding never calls them, ' +
        'so an implementation could stub or throw from them and still earn a profile. Either ' +
        'use them in the binding, or make them optional in the specification and say why.',
    ).toEqual([]);
  });
});
