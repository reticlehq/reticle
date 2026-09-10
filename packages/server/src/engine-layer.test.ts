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
 * It is not liftable today. Thirteen runtime imports cross out of it, and they are listed below
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
  // Generic value narrowing -- `asString`, `asNumber` -- that lives under `tools/` because that is
  // where it was first needed, not because it has anything to do with tools. Moving it somewhere
  // neutral removes four of these at once, and touches forty-nine files.
  'accepted-write.ts -> tools': 'asString / asNumber, generic narrowing under the wrong roof',
  'contradictions.ts -> tools': 'asString / asNumber, generic narrowing under the wrong roof',
  'unread-outcome.ts -> tools': 'asString / asNumber, generic narrowing under the wrong roof',
  'event-filters.ts -> tools': 'asString / asNumber, generic narrowing under the wrong roof',
  // Genuinely about the tool surface. These files measure how an agent used the tools, which is a
  // question about the surface rather than about a verdict -- so the answer is probably that they
  // belong with `tools/`, not that the engine needs to reach them.
  'tool-hit-rate.ts -> tools':
    'reads the tool tables; likely belongs beside tools rather than here',
  'lineage.ts -> tools': 'reads tool names; same question',
  'feature-capture.ts -> tools': 'reads the tool tables',
  'feature-capture.ts -> runs': 'reads run shapes',
  // Live session state reached from inside a rule. The engine should be given what it needs rather
  // than fetching it, which is also what makes a rule testable without a browser.
  'predicate.ts -> session': 'asks the live session directly',
  'verified.ts -> session': 'asks the live session directly',
  'predicate.ts -> capsule': 'reads stored capsules',
  'predicate.ts -> journal': 'reads the journal',
  'event-filters.ts -> input': 'reads input state',
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

  it('reaches out of itself only where it already did', () => {
    expect(
      crossings(),
      'The verdict engine gained a new runtime dependency on the rest of the server. Every one of ' +
        'these has to be answered before the engine can be its own package, so the list is allowed ' +
        'to shrink and not to grow. If the new one is unavoidable, add it here with what it needs.',
    ).toEqual(Object.keys(CROSSINGS_TODAY).sort());
  });

  it('every crossing says what it will take to remove', () => {
    // A list of paths with no reasons is a list nobody can act on, and this one exists to be acted
    // on rather than admired.
    for (const [crossing, why] of Object.entries(CROSSINGS_TODAY)) {
      expect(why.length, crossing).toBeGreaterThan(15);
    }
  });
});
