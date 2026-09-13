import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as ovp from './index.js';

/**
 * Every rule this package publishes must be executed by a test in this package.
 *
 * A normal library does not owe this: its functions exist to be called by its consumers, and an
 * uncalled export is simply one nobody needed yet. A SPECIFICATION owes it. These functions are
 * the rules -- `evidenceIsAdmissible` is the epoch rule, `moreAuthoritative` is the provenance
 * order, `outcomeOf` decides whether a run counts as a pass -- and they are published so that
 * somebody who will never read this TypeScript can implement the same behaviour. A rule nobody
 * here has executed is a rule nobody has checked, shipped as though it were settled.
 *
 * Eight had never been executed at all: not by `adjudicate`, not by the binding, not by a test.
 * They were found by counting call sites by hand, which is a thing one person does once. This is
 * the same count as a rule, so the ninth cannot arrive quietly.
 *
 * It asserts EXECUTED BY A TEST, not "called somewhere in the repository". Those come apart in
 * the direction that matters: the whole point of the package is that its rules are for other
 * people's implementations, so "Reticle happens to call it" is not evidence the rule works, and
 * "Reticle does not call it" is not evidence that it is dead.
 */

const PACKAGE = join(
  execFileSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: import.meta.dirname,
    encoding: 'utf8',
  }).trim(),
  'openreality',
);

/** Every function the package's public entry exports. Classes count: they are extended. */
function publishedRules(): string[] {
  return Object.entries(ovp)
    .filter(([, value]) => 'function' === typeof value)
    .map(([name]) => name)
    .sort();
}

/**
 * Every test in this package: comments AND import statements stripped.
 *
 * Comments, because this repository has had a source-matching guard pass on a comment that
 * quoted the code it replaced. A rule named in prose has not been executed.
 *
 * Imports, because the first version of this guard did not strip them and its own negative
 * control exposed it: deleting every call to `canProve` and leaving a comment behind still
 * passed, since the name survived in the `import { canProve, ... }` line. A guard that accepts
 * an unused import is a guard that accepts exactly the state it exists to forbid -- the rule was
 * imported, never run, and looked proved.
 */
function testCode(): string {
  const files = execFileSync('git', ['ls-files', 'src'], { cwd: PACKAGE, encoding: 'utf8' })
    .split('\n')
    .filter((f) => f.includes('.test.'));
  return files
    .map((f) => readFileSync(join(PACKAGE, f), 'utf8'))
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/^import\s[\s\S]*?from\s+'[^']*';$/gm, '');
}

describe('the specification proves the rules it publishes', () => {
  it('finds rules and tests, so a passing run cannot mean it read nothing', () => {
    expect(publishedRules().length).toBeGreaterThan(20);
    expect(testCode().length).toBeGreaterThan(2000);
  });

  it('executes every published rule in a test', () => {
    const code = testCode();
    const unproved = publishedRules().filter((name) => !new RegExp(`\\b${name}\\b`).test(code));
    expect(
      unproved,
      'these are exported as rules and no test in this package executes them, so the behaviour ' +
        'an outside implementation is asked to reproduce has never been run. Write the test, or ' +
        'stop exporting it.',
    ).toEqual([]);
  });
});
