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
 * It is not liftable today. Two runtime imports cross out of it -- thirteen when this was written --
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
  // Four crossings that used to be here are gone: `asString` and `asNumber` were generic value
  // narrowing filed under `tools/` because that is where they were first needed, and they now live in
  // the shared foundation where the engine can read them without reaching through the tool surface.
  // Two more are gone. Folding the daemon's view of a network request onto the page's own view was
  // filed under `input/` beside the code that collects the daemon's half, but it is a decision about
  // what happened rather than a way of finding out, so it moved to the engine and left the
  // collecting behind.
  // `pageTornDownWhileOn` is the single sentence both the verdict and the setup
  // diagnosis use for a page that went away, kept in one place so the two cannot describe the same
  // teardown differently. It now sits beside the rules, and the diagnosis reads it from there --
  // delivery may depend on the engine, which is the direction that lets the engine be lifted out.
  // Three more are gone, and the answer was that the files sat in the wrong place rather than that
  // the engine needed them. `tool-hit-rate` and `feature-capture` measure how an agent used the tool
  // surface, which is a question about the surface and not about whether a consequence held. Both
  // were imported BY tools/ as well as importing FROM it, so the dependency already pointed there in
  // both directions.
  'predicate.ts -> capsule':
    'converts a predicate into the links a divergence capsule walks. Takes an engine concept and ' +
    'produces a capsule one, so it belongs at one end or the other rather than being reached across',
  'predicate.ts -> journal':
    'ambient-region learning, which decides when a page has settled. That is an engine question ' +
    'implemented in the journal',
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
      /^import\s+(type\s+)?\{?([^}]*?)\}?\s*from '(\.\.\/[a-z-]+\/[^']+)';/gm,
    )) {
      const named = match[2] ?? '';
      const everyNameIsAType = named
        .split(',')
        .filter((part) => part.trim().length > 0)
        .every((part) => part.trim().startsWith('type '));
      if (match[1] !== undefined || everyNameIsAType) continue;
      const layer = (match[3] ?? '').split('/')[1] ?? '';
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
