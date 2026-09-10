import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The rules that decide a verdict should not need the machinery that delivers one.
 *
 * `events/` and `honesty/` are the engine: they read what happened and say whether the declared
 * consequence held. Everything else in this package is delivery -- a socket to the page, a tool
 * surface for an agent, a command line, somewhere to put the answer. The engine is meant to be
 * liftable out of all of that, because somebody implementing the specification wants the rules
 * without the daemon.
 *
 * It is not liftable today. Three runtime imports cross out of it -- thirteen when this was written --
 * and they are listed below
 * rather than banned, because a guard that is red the day it is written teaches people to switch it
 * off rather than to fix anything.
 *
 * So this is a ratchet, not a wall. The list cannot grow. Every entry is a thing the extraction will
 * have to answer, and the list shrinking is the work going well.
 *
 * TYPE-ONLY imports are not counted. `import type` is erased at build time, so it creates no runtime
 * dependency and does not stand between the engine and its own package.
 */

const REPO_ROOT = join(__dirname, '..', '..', '..');

/** The directories that decide a verdict. */
const ENGINE = ['packages/server/src/events', 'packages/server/src/honesty'];

/**
 * Every runtime import that currently leaves the engine, as `file -> layer`.
 *
 * Grouped by what each one will need. Read this as the extraction's to-do list.
 */
const CROSSINGS_TODAY: Record<string, string> = {
  // What used to be here, and what the answer turned out to be each time.
  //
  // Nothing was extracted by force. In every case the file was simply in the wrong place: `asString`
  // and `asNumber` were generic value narrowing filed under the tool surface because that is where
  // they were first needed; `tool-hit-rate` and `feature-capture` measure how an agent used the tool
  // surface, which is a question about the surface; `pageTornDownWhileOn` is one sentence both the
  // verdict and the setup diagnosis say; folding the daemon's view of a network request onto the
  // page's own view is a decision about what happened rather than a way of finding out; learning
  // which parts of a page change on their own is the same kind of judgement, and only the storing of
  // what was learned stayed behind; turning a declared consequence into the shape the capsule walks
  // is the rules reading their own input.
  //
  // Two are left, and they are a different kind. Neither is a rule in the wrong folder -- they are
  // the two things every part of this package uses.
  'predicate.ts -> log':
    'writes to the daemon log. A lifted engine has no daemon to log to, so this becomes something ' +
    'handed in by whoever runs the rules, the way the scaffolder is handed everything it cannot ' +
    'know for itself, rather than something reached for',
  'contradiction-folds.ts -> log': 'the same, in the second file that writes to the log',
  'predicate.ts -> trace':
    'attaches the current trace span. Same answer as the log: a lifted engine is handed somewhere ' +
    'to record what it did, and does not go looking for the daemon it was cut out of',
};

/** Runtime (non-type) imports leaving the engine, as `file -> layer`. */
function crossings(): string[] {
  const files = execFileSync('git', ['ls-files', ...ENGINE], { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\n')
    .filter((f) => f.endsWith('.ts') && !f.includes('.test.'));

  const found: string[] = [];
  for (const file of files) {
    const text = readFileSync(join(REPO_ROOT, file), 'utf8');
    for (const match of text.matchAll(
      /^import\s+(type\s+)?\{?([^}]*?)\}?\s*from '(\.\.\/[^']+)';/gm,
    )) {
      const named = match[2] ?? '';
      const everyNameIsAType = named
        .split(',')
        .filter((part) => part.trim().length > 0)
        .every((part) => part.trim().startsWith('type '));
      if (match[1] !== undefined || everyNameIsAType) continue;
      // `../input/foo.js` is a whole layer; `../log.js` is a single file sitting at the package
      // root. Both are outside the engine, and for a long time only the first shape was looked for,
      // so two real crossings sat in plain sight and the count read lower than it was.
      const target = (match[3] ?? '').slice('../'.length);
      const layer = target.includes('/')
        ? (target.split('/')[0] ?? '')
        : target.replace(/\.js$/, '');
      if ('events' === layer || 'honesty' === layer) continue;
      const name = file.split('/').pop() ?? file;
      found.push(`${name} -> ${layer}`);
    }
  }
  return [...new Set(found)].sort();
}

describe('the verdict engine is one lift away from its own package', () => {
  it('finds the engine at all', () => {
    // Without this, a rename would empty the scan and the ratchet below would pass on nothing.
    const files = execFileSync('git', ['ls-files', ...ENGINE], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    expect(files.split('\n').filter((f) => f.endsWith('.ts')).length).toBeGreaterThan(20);
  });

  it('gains no new dependency on the rest of the server', () => {
    // Growth is the failure. Two assertions rather than one equality, because equality would fail on
    // a REMOVED crossing too -- and a guard that goes red when the work goes well is one people learn
    // to silence. That mistake was in this file's first version.
    expect(
      crossings().filter((c) => !Object.hasOwn(CROSSINGS_TODAY, c)),
      'The verdict engine gained a new runtime dependency on the rest of the server. Every one of ' +
        'these has to be answered before the engine can be its own package. If the new one is ' +
        'unavoidable, add it to the list with what it will take to remove.',
    ).toEqual([]);
  });

  it('and the list does not describe crossings that are gone', () => {
    // The other direction, and the reason it is a separate check: a stale entry makes the remaining
    // work look bigger than it is, and the list is meant to be read as a to-do list.
    const live = new Set(crossings());
    expect(
      Object.keys(CROSSINGS_TODAY).filter((c) => !live.has(c)),
      'These crossings no longer exist. Remove them from the list: it is read as what is left to do.',
    ).toEqual([]);
  });

  it('every crossing says what it will take to remove', () => {
    // A list of paths with no reasons is a list nobody can act on, and this one exists to be acted
    // on rather than admired.
    for (const [crossing, why] of Object.entries(CROSSINGS_TODAY)) {
      expect(why.length, crossing).toBeGreaterThan(15);
    }
  });
});
