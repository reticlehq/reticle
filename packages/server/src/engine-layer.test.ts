import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The rules that decide a verdict do not need the machinery that delivers one.
 *
 * `events/` and `honesty/` are the rules: they read what happened and say whether the declared
 * consequence held. Everything else in this package is delivery -- a socket to the page, a tool
 * surface for an agent, a command line, somewhere to put the answer. The rules have to be liftable
 * out of all of that, because somebody implementing the specification wants the rules without the
 * daemon.
 *
 * Nothing crosses out of them any more. This started as a list of thirteen and was written as a
 * ratchet -- the list could shrink, never grow -- because a check that is red the day it is written
 * teaches people to switch it off rather than to fix anything. The list is now empty, so the same
 * check has become a wall, with no change to what it does.
 *
 * Every one of the thirteen was answered the same two ways. Most were files simply filed in the
 * wrong place: value narrowing under the tool surface because that is where it was first needed,
 * measurements of the tool surface under the rules, one shared sentence written on the side that
 * happened to say it first. The last two were real needs -- somewhere to write a note, and a way to
 * keep a re-check attached to the call that asked for it -- and those are now handed to the rules by
 * whoever runs them, on the object they were already being handed.
 *
 * TYPE-ONLY imports are not counted. `import type` is erased when the code is built, so it creates
 * no dependency at run time and nothing has to travel with the rules to satisfy it.
 */

const REPO_ROOT = join(__dirname, '..', '..', '..');

/** The directories that decide a verdict. */
const ENGINE = ['packages/server/src/events', 'packages/server/src/honesty'];

/**
 * Every runtime import that currently leaves the engine, as `file -> layer`.
 *
 * Grouped by what each one will need. Read this as the extraction's to-do list.
 */
const CROSSINGS_TODAY: Record<string, string> = {};

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
