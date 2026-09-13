import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { asRecord } from '@reticlehq/core';

/**
 * The rules must keep working without the daemon they came out of.
 *
 * They used to live inside the server package, and a list here held every place they reached back
 * into it -- thirteen at the start, then none. The move to a package of their own retired that list:
 * a reach into the server would now be an import of a package this one does not depend on, and the
 * compiler refuses it. `check-boundaries.mjs` refuses it a second time, at the level of what this
 * package is allowed to declare a dependency on.
 *
 * Two things neither of those can see are left, and they are what this file is for.
 *
 * The first is a dependency added to `package.json` that nobody needs. The rules answer questions
 * about what happened; that needs no page, no socket, no file system and no clock of its own. A
 * dependency creeping in is how a package that was easy to adopt stops being easy to adopt, and
 * neither the compiler nor the boundary checker has an opinion about a dependency that is merely
 * unnecessary.
 *
 * The second is reaching for a runtime instead. `document`, `window`, `process`, `fs` -- all of them
 * type-check perfectly well and all of them mean these rules can only run in one place.
 */

const ENGINE_ROOT = join(import.meta.dirname, '..');

/** The source files of the rules themselves, tests excluded. */
function ruleSources(): string[] {
  return execFileSync('git', ['ls-files', 'src'], { cwd: ENGINE_ROOT, encoding: 'utf8' })
    .split('\n')
    .filter((f) => f.endsWith('.ts') && !f.includes('.test.'));
}

/**
 * What the rules are allowed to depend on, and why each one is here.
 *
 * Keep this short. Every addition is something a person adopting the rules also has to accept.
 */
const ALLOWED_DEPENDENCIES: Record<string, string> = {
  '@reticlehq/core': 'the shared vocabulary: the names for events, verdicts and consequences',
  zod: 'checking that a predicate handed in from outside is really shaped like a predicate',
};

/**
 * The parts of a file that are actually instructions: comments and text taken out.
 *
 * The first version of the check below read whole files and reported twelve things, every one of
 * them prose. These rules talk about a "window" of events constantly, one of their own files is
 * called `observed-in-window.js`, and one string literal is `'window.evidence-superseded'`. A check
 * that cries wolf is switched off within a week, which costs you the check.
 */
function codeOnly(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ' '))
    .join('\n')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
}

/**
 * Runtimes the rules must not assume they are inside.
 *
 * `document` and `window` are deliberately NOT here. This package loads no browser type
 * definitions, so reaching for either is already a compile error and cannot get past a build --
 * and searching the text for them finds the word "window" used for a span of time, which is what it
 * nearly always means in these files. The check below pins the setting that makes that true, which
 * is the honest way to cover it.
 *
 * What is left is what the compiler will NOT refuse: Node is available here, because the tests need
 * it, so a rule could quietly start reading a file or an environment variable and type-check
 * perfectly.
 */
const RUNTIME_GIVEAWAYS = [
  {
    pattern: /(?<![\w-])process\s*\.\s*(env|exit|cwd|stdout|stderr|argv)\b/,
    name: 'process',
  },
  { pattern: /from 'node:/, name: 'a node: module' },
];

describe('the rules stand on their own', () => {
  it('finds the rules at all — a check that reads nothing passes about nothing', () => {
    expect(ruleSources().length).toBeGreaterThan(40);
  });

  it('asks the people who adopt them to accept only what they must', () => {
    const manifest: unknown = JSON.parse(readFileSync(join(ENGINE_ROOT, 'package.json'), 'utf8'));
    const declared = Object.keys(asRecord(asRecord(manifest)?.['dependencies']) ?? {}).sort();
    expect(
      declared,
      'A new dependency here is one more thing everybody adopting the rules has to take with ' +
        'them. If it is genuinely needed, add it to ALLOWED_DEPENDENCIES with the reason.',
    ).toEqual(Object.keys(ALLOWED_DEPENDENCIES).sort());
  });

  it('loads no browser type definitions, so a page global cannot compile', () => {
    const tsconfig = readFileSync(join(ENGINE_ROOT, 'tsconfig.json'), 'utf8');
    expect(
      /"lib"\s*:\s*\[[^\]]*"DOM"/i.test(tsconfig),
      'Adding the DOM type definitions here would let `document` and `window` compile, and the ' +
        'rules would quietly become browser-only.',
    ).toBe(false);
  });

  it('does not reach for a Node process', () => {
    const found: string[] = [];
    for (const file of ruleSources()) {
      const text = codeOnly(readFileSync(join(ENGINE_ROOT, file), 'utf8'));
      for (const giveaway of RUNTIME_GIVEAWAYS) {
        if (giveaway.pattern.test(text)) found.push(`${file} reaches for ${giveaway.name}`);
      }
    }
    expect(
      found,
      'The rules read what happened and answer a question about it. Anything that ties them to ' +
        'one runtime is the reason somebody cannot use them where they are.',
    ).toEqual([]);
  });
});
