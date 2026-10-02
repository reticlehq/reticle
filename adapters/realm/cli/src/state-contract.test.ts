import { describe, expect, it } from 'vitest';
import { CliRealm } from './cli-realm.js';
import type { CommandManifest } from './manifest.js';
import type { Invocation, Supervisor } from './process/supervisor.js';

const invocation: Invocation = {
  id: 'i1',
  command: 'build',
  argv: [],
  startedAt: 0,
  endedAt: 1,
  exit: { code: 0, signal: undefined, wasSignalled: false },
  stdout: [],
  stderr: [],
  settledMs: 0,
};
const supervisor: Supervisor = {
  run: () => Promise.resolve(invocation),
  invocationsSince: () => [invocation],
  toolIdentity: () => ({ id: 't', version: '1', workspace: 'ws' }),
};
const manifest: CommandManifest = { workspaceRoot: '/ws', commands: [] };
const realm = new CliRealm({ supervisor, manifest, now: () => 0 });

describe('whether one step leaves the next one what it needs', () => {
  /**
   * A CLI's state IS its workspace, so the contract is written in paths.
   *
   * The protocol carries `requires` and `ensures` and never parses them -- a protocol that did
   * would be one with an opinion about what a subject is. Only the realm knows what its own state
   * values mean, and for a command-line subject they mean: these paths are there, these are not.
   */
  it('agrees when the earlier step ensures every path the later one needs', () => {
    expect(
      realm.satisfies({ paths: ['dist/index.js', 'dist/cli.js'] }, { paths: ['dist/index.js'] }),
    ).toBe(true);
  });

  it('refuses when the later step needs something nothing established', () => {
    expect(realm.satisfies({ paths: ['dist/index.js'] }, { paths: ['node_modules'] })).toBe(false);
  });

  /**
   * Refusing BEFORE the journey runs is the whole value.
   *
   * A composite whose parts cannot stitch fails at rest, with an address, rather than halfway
   * through a sub-journey that is working correctly and leaving the workspace somewhere nobody
   * planned and nothing can return it from.
   */
  it('handles the absence half, which is a different claim from presence', () => {
    expect(realm.satisfies({ paths: ['dist/index.js'] }, { absent: ['dist/index.js'] })).toBe(
      false,
    );
    expect(realm.satisfies({ paths: ['dist/index.js'] }, { absent: ['dist/stale.js'] })).toBe(true);
  });

  /**
   * A shape this realm does not recognise is "I cannot tell", NEVER "yes".
   *
   * The protocol is explicit that a caller must report that distinctly and must not read it as
   * agreement, because a check that treats "cannot tell" as "yes" can only ever pass -- and a
   * check that cannot fail is worse than no check, because it reads as one.
   */
  it('says it cannot tell rather than guessing at a vocabulary it does not speak', () => {
    expect(realm.satisfies({ database: 'seeded' }, { database: 'seeded' })).toBeUndefined();
    expect(realm.satisfies(undefined, { paths: ['x'] })).toBeUndefined();
    expect(realm.satisfies({ paths: ['x'] }, 'a sentence')).toBeUndefined();
  });

  /**
   * An empty requirement is satisfied by anything, and that is not a loophole.
   *
   * A step that needs nothing from its predecessor genuinely can follow any step. Reporting that
   * as "cannot tell" would make every journey whose first step is self-sufficient unjudgeable.
   */
  it('lets a step that needs nothing follow anything', () => {
    expect(realm.satisfies({ paths: [] }, { paths: [] })).toBe(true);
  });

  /**
   * It compares DECLARATIONS and never touches the disk.
   *
   * This runs at typecheck time, before the journey has been driven, so there is no filesystem
   * state to consult -- `/ws` may not even exist yet. A version that stat'ed paths would answer
   * about the wrong moment and would pass or fail depending on what a previous run left behind.
   */
  it('answers without a workspace on disk, because it is a check at rest', () => {
    const noDisk = new CliRealm({
      supervisor,
      manifest: { workspaceRoot: '/definitely/not/here', commands: [] },
      now: () => 0,
    });
    expect(noDisk.satisfies({ paths: ['a.js'] }, { paths: ['a.js'] })).toBe(true);
  });
});

describe('a journey refused before a single command is spent', () => {
  const composite = (order: readonly string[]) => [
    { name: 'journey', steps: order.map((invoke) => ({ invoke })) },
    { name: 'install', steps: [{}], ensures: { paths: ['node_modules'] } },
    { name: 'build', steps: [{}], ensures: { paths: ['dist/index.js'] } },
    { name: 'test', steps: [{}], requires: { paths: ['dist/index.js'] } },
  ];

  /**
   * The point of all of this, driven through the protocol's own composite typecheck.
   *
   * `test` needs `dist/index.js` and `install` does not produce it. Ordered wrongly, the journey
   * is refused AT REST with the step named, rather than running `install`, running `test`,
   * failing on a missing file, and leaving somebody to work out which of the three things broke.
   */
  it('names the step whose requirement nothing established', async () => {
    const { typecheckComposite } = await import('open-verification');
    const errors = typecheckComposite(composite(['install', 'test']), 'journey', (e, r) =>
      realm.satisfies(e, r),
    );
    expect(errors.map((e) => e.kind)).toContain('unsatisfied-requirement');
  });

  it('passes the same journey once a step establishes what the next one needs', async () => {
    const { typecheckComposite } = await import('open-verification');
    const errors = typecheckComposite(composite(['build', 'test']), 'journey', (e, r) =>
      realm.satisfies(e, r),
    );
    expect(errors).toEqual([]);
  });

  /**
   * Without the realm's answer, the SAME broken journey typechecks clean.
   *
   * Which is what `satisfies` returning the base class's `undefined` would have produced: a
   * composite check that cannot fail, reading as one that passed.
   */
  it('cannot catch the bad order at all when nobody answers the contract', async () => {
    const { typecheckComposite } = await import('open-verification');
    expect(typecheckComposite(composite(['install', 'test']), 'journey')).toEqual([]);
  });
});
