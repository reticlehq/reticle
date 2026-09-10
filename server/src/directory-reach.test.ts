import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Which directories in this package reach for which other ones.
 *
 * This package is large, and its directories grew by adding a file wherever the person writing it
 * happened to be standing. Nothing ever said which directory was allowed to know about which, so the
 * answer today is: nearly all of them, in both directions.
 *
 * Two numbers are frozen here. The first is the map below -- who reaches for whom. The second is how
 * many pairs reach for EACH OTHER, which is the number that actually says how tangled this is: when
 * two directories both need the other, neither can be read, moved, tested or explained on its own.
 *
 * Neither number may grow. Both may shrink, and shrinking is the work going well.
 *
 * It is written as a freeze rather than a rule about which directories SHOULD depend on which,
 * because a rule strict enough to be worth having would be red on the day it was written, against a
 * hundred and twenty-four existing pairs. A check that is red on day one teaches people to switch it
 * off rather than to fix anything. This one is green today and refuses the next accidental edge,
 * which is the difference between stopping the mess and merely describing it.
 *
 * TYPE-ONLY imports count here, unlike in some other checks. A shape that two directories share is
 * still a thing they both have to agree about, and it is still what makes them impossible to move
 * apart -- the cost this is measuring is understanding, not bytes.
 */

const SERVER_SRC = join(__dirname);

/**
 * What each directory reaches for today. Adding an entry is a decision, which is the point.
 *
 * Before adding one, the question worth asking is whether the thing being reached for actually
 * belongs where it is. Most of the crossings removed from this repo so far turned out to be a file
 * filed in the wrong place rather than a dependency anybody needed.
 */
const REACHES_FOR: Record<string, readonly string[]> = {
  bridge: ['flows', 'impact', 'project', 'session', 'telemetry', 'tools', 'version'],
  capsule: ['project'],
  cli: [
    'bridge',
    'capsule',
    'cloud',
    'daemon',
    'flows',
    'mcp',
    'project',
    'runs',
    'session',
    'setup',
    'tools',
    'update',
    'version',
  ],
  cloud: ['cli', 'intent', 'project'],
  crawl: ['project', 'session', 'tools'],
  daemon: ['telemetry'],
  domain: ['flows', 'oracles', 'project', 'tools'],
  ee: ['license'],
  flows: ['cli', 'cloud', 'intent', 'journal', 'project', 'runs', 'session', 'tools'],
  impact: ['cloud', 'session'],
  input: ['pool', 'telemetry', 'tools'],
  intent: ['project', 'tools'],
  journal: ['project', 'runs'],
  license: ['cli'],
  mcp: ['cli', 'daemon', 'session', 'telemetry', 'tools', 'version'],
  memory: ['cloud', 'project', 'tools'],
  pool: ['cli', 'input', 'telemetry'],
  project: ['cli', 'cloud', 'flows', 'runs', 'tools'],
  runs: ['cloud', 'flows', 'intent', 'mcp', 'project', 'telemetry', 'tools'],
  session: ['bridge', 'cli', 'daemon', 'impact', 'input', 'journal', 'mcp', 'telemetry', 'tools'],
  setup: ['bridge', 'cli', 'daemon', 'mcp', 'telemetry'],
  telemetry: ['cli', 'daemon', 'license', 'mcp', 'session', 'tools', 'update', 'version'],
  tools: [
    'capsule',
    'cli',
    'crawl',
    'daemon',
    'domain',
    'flows',
    'impact',
    'input',
    'intent',
    'mcp',
    'memory',
    'oracles',
    'pool',
    'project',
    'runs',
    'session',
    'telemetry',
    'update',
    'version',
    'visual',
  ],
  update: ['project', 'telemetry', 'version'],
  version: ['project', 'tools'],
  visual: ['input', 'project', 'tools'],
};

/**
 * The pairs that reach for each other. This is the shape that makes a directory unmovable.
 *
 * Kept as a count rather than a list on purpose: the list is derivable and printed on failure, and a
 * hand-written copy of it would be one more thing to keep in step.
 */
const MUTUAL_PAIRS_TODAY = 32;

/** Every directory under `src`, and what it imports from a sibling. */
function reaches(): Map<string, Set<string>> {
  const files = execFileSync('git', ['ls-files', 'src'], {
    cwd: join(SERVER_SRC, '..'),
    encoding: 'utf8',
  })
    .split('\n')
    .filter((f) => f.endsWith('.ts') && !f.includes('.test.'));

  const found = new Map<string, Set<string>>();
  for (const file of files) {
    const parts = file.split('/');
    // `src/tools/act.ts` is inside a directory; `src/cli.ts` is not, and has no siblings to cross.
    if (parts.length < 3) continue;
    const own = parts[1] ?? '';
    const text = readFileSync(join(SERVER_SRC, '..', file), 'utf8');
    for (const match of text.matchAll(/from '\.\.\/([a-z-]+)\//g)) {
      const other = match[1] ?? '';
      if (other === own) continue;
      const already = found.get(own) ?? new Set<string>();
      already.add(other);
      found.set(own, already);
    }
  }
  return found;
}

/** The pairs where each reaches for the other, as `a <-> b`, each pair named once. */
function mutualPairs(found: Map<string, Set<string>>): string[] {
  const pairs = new Set<string>();
  for (const [one, targets] of found) {
    for (const other of targets) {
      if (true === found.get(other)?.has(one)) pairs.add([one, other].sort().join(' <-> '));
    }
  }
  return [...pairs].sort();
}

describe('the directories in this package know only what they are allowed to know', () => {
  it('finds the directories at all — a check over nothing passes about nothing', () => {
    // A rename could empty the scan, and then everything below would pass by having read no code.
    expect(reaches().size).toBeGreaterThan(20);
  });

  it('gains no new reach into another directory', () => {
    const found = reaches();
    const added: string[] = [];
    for (const [one, targets] of found) {
      for (const other of targets) {
        if (!(REACHES_FOR[one] ?? []).includes(other)) added.push(`${one} -> ${other}`);
      }
    }
    expect(
      added.sort(),
      'A directory here started reaching for one it did not before. Ask first whether the thing ' +
        'it wants is in the right place: most crossings removed from this package so far were a ' +
        'file filed somewhere odd rather than a dependency anybody needed. If the reach is really ' +
        'necessary, add it to REACHES_FOR.',
    ).toEqual([]);
  });

  it('does not describe reaches that are gone', () => {
    // The other direction, and a separate check because using one equality for both would go red
    // when a reach is REMOVED -- and a check that punishes the work going well gets switched off.
    const found = reaches();
    const stale: string[] = [];
    for (const [one, targets] of Object.entries(REACHES_FOR)) {
      for (const other of targets) {
        if (true !== found.get(one)?.has(other)) stale.push(`${one} -> ${other}`);
      }
    }
    expect(
      stale.sort(),
      'These reaches no longer exist. Take them out: this list is meant to be read as what is ' +
        'still tangled.',
    ).toEqual([]);
  });

  it('has no more pairs that need each other than it had', () => {
    const pairs = mutualPairs(reaches());
    expect(
      pairs.length,
      `Two directories that each need the other cannot be read, moved or tested apart. There are ` +
        `now ${String(pairs.length)}, and there were ${String(MUTUAL_PAIRS_TODAY)}:\n` +
        pairs.map((p) => `  ${p}`).join('\n'),
    ).toBeLessThanOrEqual(MUTUAL_PAIRS_TODAY);
  });
});
