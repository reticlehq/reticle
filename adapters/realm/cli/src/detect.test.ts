import { describe, expect, it } from 'vitest';
import {
  AnomalyKind,
  AnomalyTier,
  Verdict,
  Ground,
  adjudicate,
  Declaration,
} from 'open-verification';
import { CliRealm } from './cli-realm.js';
import type { CommandManifest } from './manifest.js';
import type { Invocation, Supervisor } from './process/supervisor.js';
import type { Snapshot, WorkspacePort } from './workspace/port.js';

const empty: Snapshot = { files: new Map(), unreadable: [] };
const withFile = (path: string): Snapshot => ({
  files: new Map([[path, { hash: 'h', size: 4, mode: 0o644, linkTo: undefined }]]),
  unreadable: [],
});

function supervisorOf(over: Partial<Invocation> = {}): Supervisor {
  const invocation: Invocation = {
    id: 'i1',
    command: 'build',
    argv: ['build'],
    startedAt: 0,
    endedAt: 10,
    exit: { code: 0, signal: undefined, wasSignalled: false },
    stdout: [{ seq: 0, text: 'wrote dist/index.js' }],
    stderr: [],
    settledMs: 0,
    ...over,
  };
  return {
    run: () => Promise.resolve(invocation),
    invocationsSince: () => [invocation],
    toolIdentity: () => ({ id: 'tool', version: '1', workspace: 'ws' }),
  };
}

const manifest: CommandManifest = {
  workspaceRoot: '/tmp/ws',
  commands: [{ name: 'build', meaning: 'build', mutating: true, argv: ['build'] }],
};

function scripted(looks: readonly Snapshot[]): WorkspacePort {
  let next = 0;
  return {
    roots: ['/tmp/ws'],
    excluded: [],
    snapshot: () => looks[Math.min(next++, looks.length - 1)] ?? empty,
  };
}

const realm = (supervisor: Supervisor, workspace?: WorkspacePort): CliRealm =>
  new CliRealm({ supervisor, manifest, ...(workspace ? { workspace } : {}), now: () => 100 });

describe('what the realm reports as a disagreement', () => {
  /**
   * The tool said it wrote a file; the filesystem recorded nothing.
   *
   * ABSENCE-DERIVED, and that tier is the whole of the care here. The specification is explicit
   * that "the thing I expected had not happened yet when I stopped looking" is not "it did not
   * happen", and clause 3 runs BEFORE the window check and the coverage check -- so an
   * `observed`-tier anomaly convicts before `still-in-flight` is ever consulted. A tool that
   * forks, returns, and lands its effect a second later would be convicted for working correctly.
   */
  it('reports a claimed write that never landed, and only as absence-derived', async () => {
    const r = realm(supervisorOf(), scripted([empty, empty]));
    const window = r.closeWindow(r.openWindow(5_000));
    const found = await r.detect(window, await r.observe(window));
    const advanced = found.find((a) => a.kind === AnomalyKind.ADVANCED_OVER_FAILURE);
    expect(advanced?.tier).toBe(AnomalyTier.ABSENCE_DERIVED);
  });

  it('says nothing when the tool claimed a write and the write is there', async () => {
    const r = realm(supervisorOf(), scripted([empty, withFile('/tmp/ws/dist/index.js')]));
    const window = r.closeWindow(r.openWindow(5_000));
    const found = await r.detect(window, await r.observe(window));
    expect(found.filter((a) => a.kind === AnomalyKind.ADVANCED_OVER_FAILURE)).toEqual([]);
  });

  /**
   * The tool printed success and the kernel killed it.
   *
   * OBSERVED tier, and entitled to convict, because `x-proc` is independent: the operating system
   * decided the ending and the tool did not. This is the pairing the channel split exists for. On
   * one merged channel it would be two actuation-derived channels disagreeing, which
   * `disagreementCanConvict` correctly refuses to act on, and a real crash would be unreportable.
   */
  it('convicts when the tool announced success and was killed', async () => {
    const killed = supervisorOf({
      exit: { code: undefined, signal: 'SIGKILL', wasSignalled: true },
      stdout: [{ seq: 0, text: 'done! everything succeeded' }],
    });
    const r = realm(killed, scripted([empty, empty]));
    const window = r.closeWindow(r.openWindow(5_000));
    const found = await r.detect(window, await r.observe(window));
    const claimed = found.find((a) => a.kind === AnomalyKind.CLAIMED_OVER_FAILURE);
    expect(claimed?.tier).toBe(AnomalyTier.OBSERVED);
    expect(claimed?.between).toContain('x-proc');
  });

  /**
   * Nothing anywhere recorded anything.
   *
   * Absence-derived for the same reason as the first: silence inside a window whose end we chose
   * is not proof that nothing happened.
   */
  it('reports an action that left no trace at all, as a suspicion rather than a fault', async () => {
    const silent = supervisorOf({ stdout: [], stderr: [], exit: undefined, endedAt: undefined });
    const r = realm(silent, scripted([empty, empty]));
    const window = r.closeWindow(r.openWindow(5_000));
    const found = await r.detect(window, await r.observe(window));
    const none = found.find((a) => a.kind === AnomalyKind.NO_EFFECT);
    expect(none?.tier).toBe(AnomalyTier.ABSENCE_DERIVED);
  });
});

describe('what the adjudicator does with it, end to end', () => {
  /**
   * The false green this whole adapter exists to refuse, driven through the real adjudicator.
   *
   * Exit 0, a clean close, confident output, and a claim that a file would be written. The only
   * thing that stops a `yes` is that nothing independent and consequence-grade ever paid for it.
   */
  it('refuses to prove a write that only stdout attests to', async () => {
    const r = realm(supervisorOf(), scripted([empty, empty]));
    const window = r.closeWindow(r.openWindow(5_000));
    const observed = await r.observe(window);
    const decided = adjudicate({
      claim: {
        id: 'c1',
        statement: 'the build writes dist/index.js',
        declaredAt: Declaration.BEFORE_ACTION,
        assertions: [
          {
            id: 'a1',
            predicate: {
              kind: 'present',
              match: { channel: 'x-artifact', summary: 'cli.fs.written' },
            },
            reads: 'a file was written under the workspace roots',
            channels: ['x-artifact'],
          },
        ],
      },
      window,
      channels: r.channels(),
      evidence: [],
      coverage: await r.coverage(window),
      anomalies: await r.detect(window, observed),
      assertionsHeld: false,
      consequenceHeldBefore: r.existedBefore(window, '/tmp/ws/dist/index.js'),
    });
    expect(decided.verdict).toBe(Verdict.NO);
    expect(decided.ground).toBe(Ground.ASSERTION_FAILED);
  });
});
