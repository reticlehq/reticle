import { describe, expect, it } from 'vitest';
import { mutualPairs, nameCollisions, reaches } from '../../scripts/directory-reach.mjs';

import { join } from 'node:path';
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

/**
 * The graph itself lives in `scripts/directory-reach.mjs`, not here.
 *
 * There are three callers now -- this guard, the browser package's, and `safe-to-group.mjs`,
 * which predicts what both will say. Three copies of one graph computation is three chances for
 * the prediction to disagree with the test it predicts, which would be worse than having no
 * prediction at all.
 */
const SERVER = join(REPO_ROOT, 'server');

/**
 * BEFORE MOVING FILES, ask `node scripts/safe-to-group.mjs <dir> <name...>`.
 *
 * This test is the authority and it answers only AFTER a move, which made the first round of
 * directory grouping a sequence of move, rewrite every import, run this, revert. Three of the
 * first four candidate groups had to be reverted that way -- each one an expensive route to a
 * fact that was sitting in the import graph the whole time.
 *
 * That script answers the same question first. A group is unsafe exactly when some directory it
 * reaches OUT to also reaches back IN to it, which is a mutual pair by definition and the only
 * way a grouping can raise the count below. It is a prediction of this test; this test still
 * decides.
 *
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
  act: ['capsule', 'input', 'read', 'session'],
  /**
   * The read leaves: what a snapshot or a query LOOKS like, with no opinion about what it means.
   *
   * Same construction as `act` -- nothing here imports a sibling, so `tools -> read` can never
   * become mutual.
   */
  read: [],
  /**
   * What this build could not see, and what it lacks to see it: an absent capability, a coverage
   * identity, an action that produced nothing observable, a missing source marker.
   *
   * The protocol calls this coverage, and it is the half of a verdict every other test format
   * leaves out. Reaches for nothing.
   */
  gaps: [],
  /**
   * The two kinds of form field a replay cannot just re-type: a secret, which must not be
   * recorded, and a file, which has to be found again on disk.
   */
  fields: ['tools'],
  /**
   * Who is attached to a session, and who may drive it. Reaches for NOTHING -- not even its own
   * parent -- which is the strongest form a group can take: `session` needs it, and it needs
   * nobody, so the edge cannot ever become mutual however either side grows.
   */
  presence: [],
  /**
   * The person in the loop: their review marks, their messages to the agent, and what the panel
   * is told to show them. Reaches for nothing.
   */
  human: [],
  /**
   * What a flow's result MEANS -- whether an assertion still has integrity, who a failure belongs
   * to, why a role drifted. Reaches for nothing, like `presence`, so both edges into it are
   * permanently one-way.
   */
  outcome: [],
  /**
   * Which port a daemon binds, who already holds one, and which siblings are up.
   *
   * Seven directories reach for it, which is the argument for its existing: a question that many
   * parts of a program ask is a thing, and it was seven files in the middle of the CLI. It
   * reaches for nothing itself.
   */
  ports: [],
  /**
   * Talking to the person at the terminal: asking, interrupting, showing progress, recording what
   * was said. Named `terminal` and not `console`, which in a JavaScript codebase means the API.
   *
   * It reaches for four things and that is honest -- it prints daemon state, port state and
   * telemetry notices, because that is what a setup transcript is made of.
   */
  terminal: ['cli', 'daemon', 'ports', 'telemetry'],
  /** A recorded flow and what became of it: the tape, the rewind, the flake, the halt. */
  recording: [],
  /** What a human wrote on a step, and where they pointed when they wrote it. */
  'annotate-notes': [],
  bridge: ['recording', 'flows', 'impact', 'project', 'session', 'telemetry', 'tools', 'version'],
  capsule: ['project'],
  cli: [
    'recording',
    'ports',
    'outcome',
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
    'ports',
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
  flows: [
    'fields',
    'annotate-notes',
    'recording',
    'outcome',
    'act',
    'cli',
    'cloud',
    'intent',
    'journal',
    'project',
    'runs',
    'session',
    'tools',
  ],
  impact: ['cloud', 'session'],
  input: ['pool', 'telemetry', 'tools'],
  intent: ['project', 'tools'],
  journal: ['project', 'runs'],
  license: ['cli'],
  mcp: ['ports', 'cli', 'daemon', 'session', 'telemetry', 'tools', 'version'],
  memory: ['cloud', 'project', 'tools'],
  pool: ['cli', 'input', 'telemetry'],
  project: ['cli', 'cloud', 'flows', 'runs', 'tools'],
  runs: ['cloud', 'flows', 'intent', 'mcp', 'project', 'telemetry', 'tools'],
  session: [
    'gaps',
    'human',
    'ports',
    'presence',
    'bridge',
    'cli',
    'daemon',
    'impact',
    'input',
    'journal',
    'mcp',
    'telemetry',
    'tools',
  ],
  setup: ['terminal', 'bridge', 'cli', 'daemon', 'mcp', 'telemetry'],
  telemetry: ['ports', 'cli', 'daemon', 'license', 'mcp', 'session', 'tools', 'update', 'version'],
  tools: [
    'gaps',
    'annotate-notes',
    'recording',
    'ports',
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

/**
 * Two directories may not share a name.
 *
 * The reach graph identifies a directory by its BASENAME, so `command/cli/cloud` and
 * `features/cloud` are one node to it. That is not a rounding error: reaches into one are
 * attributed to the other, a mutual pair between them is unreportable, and the count below --
 * the number this whole audit is steered by -- quietly measures a graph that does not exist.
 *
 * Found by walking into it. A grouping created a second `cloud/`, every reach test still passed,
 * and the only symptom was that the new directory appeared to have no reaches at all: they had
 * been credited to its namesake. A guard that can be silently defeated by naming is worse than
 * one that is missing, because it goes on reporting a number.
 *
 * Keyed on the basename rather than fixed by using full paths deliberately. Full paths would make
 * the reach list unreadable -- `agent/tools -> connection/session` twice a line -- and unique
 * short names are worth having for their own sake. This is the price of that, made loud.
 */
describe('directory names in this package are unique', () => {
  it('has no two directories sharing a basename', () => {
    const clashes = nameCollisions(SERVER);
    expect(
      clashes,
      'The reach graph identifies a directory by its basename, so these are one node to it -- ' +
        'their reaches are merged and a mutual pair between them cannot be reported. Rename one, ' +
        'or put the files in the directory that already has the name.',
    ).toEqual([]);
  });
});

describe('the directories in this package know only what they are allowed to know', () => {
  it('finds the directories at all — a check over nothing passes about nothing', () => {
    // Grouping the directories moved every one of them. A scan that silently stopped resolving
    // would report an empty graph, and every check below would pass by having read no code.
    expect(reaches(SERVER).size).toBeGreaterThan(20);
  });

  it('gains no new reach into another directory', () => {
    const found = reaches(SERVER);
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
    const found = reaches(SERVER);
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
    const pairs = mutualPairs(SERVER);
    expect(
      pairs.length,
      `Two directories that each need the other cannot be read, moved or tested apart. There are ` +
        `now ${String(pairs.length)}, and there were ${String(MUTUAL_PAIRS_TODAY)}:\n` +
        pairs.map((p) => `  ${p}`).join('\n'),
    ).toBeLessThanOrEqual(MUTUAL_PAIRS_TODAY);
  });
});
