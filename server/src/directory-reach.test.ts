import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename, dirname, join, normalize, posix } from 'node:path';
import { REPO_ROOT } from './repo-root.js';

/**
 * Which directories in this package reach for which other ones.
 *
 * The directories are now gathered into four groups, by who the code is for:
 *
 *   connection/  the live link to a running app -- the socket, what we know about a tab, driving it
 *   agent/       what an agent talks to -- the tool surface, the MCP door, what a drive produced
 *   command/     what a person runs -- the command line, the daemon's life, setup, updates
 *   features/    the things Reticle does with what it sees -- flows, journal, crawl, and the rest
 *
 * Grouping made the package legible. It did not make it less tangled, and this file exists so
 * nobody mistakes the first for the second. Two numbers are frozen: who reaches for whom, and how
 * many pairs reach for EACH OTHER -- which is the one that says whether a piece could ever leave,
 * because two directories that both need the other cannot be read, moved or tested apart.
 *
 * Neither number may grow. Both may shrink, and shrinking is the work going well.
 *
 * A freeze rather than a rule about which group SHOULD depend on which, because a rule strict enough
 * to be worth having would be red on the day it was written, and a check that is red on day one
 * teaches people to switch it off rather than to fix anything.
 *
 * Imports are RESOLVED, not pattern-matched. An earlier version looked for `../name/`, which reads
 * a cross-group import as landing in the group rather than in the directory inside it, and quietly
 * counted a third of the graph as absent.
 */

const SERVER_SRC = join(REPO_ROOT, 'server', 'src');

/** The directory each import actually lands in, for every file that has neighbours. */
function reaches(): Map<string, Set<string>> {
  const files = execFileSync('git', ['ls-files', 'src'], {
    cwd: join(SERVER_SRC, '..'),
    encoding: 'utf8',
  })
    .split('\n')
    .filter((f) => f.endsWith('.ts') && !f.includes('.test.'));

  const found = new Map<string, Set<string>>();
  for (const file of files) {
    const fromDir = posix.dirname(file);
    const own = posix.basename(fromDir);
    if ('src' === fromDir) continue; // a file with no directory of its own has no neighbours
    const text = readFileSync(join(SERVER_SRC, '..', file), 'utf8');
    for (const match of text.matchAll(/from '((?:\.\.\/|\.\/)[^']+)'/g)) {
      const target = normalize(posix.join(fromDir, match[1] ?? ''))
        .split('\\')
        .join('/');
      if (!target.startsWith('src/')) continue; // left the package: not this check's business
      const other = basename(dirname(target));
      if ('' === other || other === own || 'src' === other) continue;
      const already = found.get(own) ?? new Set<string>();
      already.add(other);
      found.set(own, already);
    }
  }
  return found;
}

/**
 * What each directory reaches for today. Adding an entry is a decision, which is the point.
 *
 * Before adding one, the question worth asking is whether the thing being reached for is in the
 * right place. Most of the reaches removed from this repo so far turned out to be a file filed
 * somewhere odd rather than a dependency anybody needed.
 */
const REACHES_FOR: Record<string, readonly string[]> = {
  // One way, and it stays one way: the OpenReality adapter reads a live session to answer the
  // protocol's eight questions, and nothing in `session` knows the adapter exists. The mutual-pair
  // count is unchanged by it, which is the test that matters -- a grouping that raises that number
  // is a shorter directory listing bought with a real property.
  realm: ['session'],
  /**
   * The act LEAVES, and why this grouping is allowed where an earlier one was not.
   *
   * A first attempt moved the whole act cluster, `act-tools.ts` included, and the mutual-pair
   * count went 32 -> 34: the tool registry and the act tools need each other, so splitting them
   * bought a shorter directory listing with a real property, and it was reverted.
   *
   * What moved instead is only the files that import NO sibling. That makes the edge strictly
   * one-way by construction -- `tools` reaches for `act`, and `act` can never reach back, because
   * nothing in it imports upward. The three reaches below are the ones these files already had
   * under their old home; they are the same edges, now attributed to the directory that owns them.
   */
  act: ['capsule', 'input', 'session'],
  /**
   * The read leaves: what a snapshot or a query LOOKS like, with no opinion about what it means.
   *
   * Same construction as `act` -- nothing here imports a sibling, so `tools -> read` can never
   * become mutual.
   */
  read: [],
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
  command: [
    'cli',
    'daemon',
    'flows',
    'hunt',
    'license',
    'mcp',
    'project',
    'session',
    'setup',
    'telemetry',
    'update',
    'version',
  ],
  crawl: ['project', 'session', 'tools'],
  daemon: ['telemetry'],
  domain: ['flows', 'oracles', 'project', 'tools'],
  ee: ['license'],
  flows: ['act', 'cli', 'cloud', 'intent', 'journal', 'project', 'runs', 'session', 'tools'],
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
    'read',
    'act',
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
 * The pairs that reach for each other -- the shape that makes a directory unmovable.
 *
 * A count rather than a list: the list is derivable and printed on failure, and a hand-written copy
 * would be one more thing to keep in step.
 */
const MUTUAL_PAIRS_TODAY = 32;

/** The pairs where each reaches for the other, as `a <-> b`, each named once. */
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
    // Grouping the directories moved every one of them. A scan that silently stopped resolving
    // would report an empty graph, and every check below would pass by having read no code.
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
      'A directory here started reaching for one it did not before. Ask first whether the thing it ' +
        'wants is in the right place: most reaches removed from this package so far were a file ' +
        'filed somewhere odd rather than a dependency anybody needed. If it is really necessary, ' +
        'add it to REACHES_FOR.',
    ).toEqual([]);
  });

  it('does not describe reaches that are gone', () => {
    // The other direction, and a separate check because one equality for both would go red when a
    // reach is REMOVED -- and a check that punishes the work going well gets switched off.
    const found = reaches();
    const stale: string[] = [];
    for (const [one, targets] of Object.entries(REACHES_FOR)) {
      for (const other of targets) {
        if (true !== found.get(one)?.has(other)) stale.push(`${one} -> ${other}`);
      }
    }
    expect(
      stale.sort(),
      'These reaches no longer exist. Take them out: this list is meant to be read as what is still ' +
        'tangled.',
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
