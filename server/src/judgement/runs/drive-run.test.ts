/**
 * The dashboard was empty because nothing wrote a run, and driving the app is the product.
 *
 * From a field session: a long run of `reticle_act_and_wait` and `reticle_assert` calls, `lastPushAt: null`
 * throughout, no rows on the platform. `diskSource.runs()` reads `.reticle/runs/`, and the only
 * writer was flow replay — so a live drive, which is how every user meets Reticle, produced no
 * artifact and therefore synced nothing.
 */
import { runDrivenBy } from '@/hooks/driven-by.js';
import { isValidRunId } from '@/memory/project/dir/reticle-dir.js';
import { describe, expect, it } from 'vitest';
import { DisparityKind, PredicateKind, Verified, type JournalAction } from '@reticlehq/core';
import {
  buildVerificationRun,
  type VerificationRunInput,
} from './artifact/build-verification-run.js';
import {
  driveRunFrom,
  driveRunId,
  driveRunsFrom,
  endAgentSession,
  onHarnessNoted,
  agentRunId,
  harnessRunId,
  runIdOfCall,
  harnessAgentId,
  noteHarnessDisparity,
  noteHarnessGoal,
  noteHarnessSpan,
} from './drive-run.js';
import { computeVerdict } from './artifact/build-verification-run.js';
import { VerdictStatus } from '@reticlehq/core';

let seq = 0;
const action = (
  verified: Verified | undefined,
  claim = 'the row disappears',
  at = ++seq,
): JournalAction => ({
  v: 1,
  actionId: `c${String(at)}`,
  tool: 'reticle_act_and_wait',
  args: {},
  ...(verified === undefined ? {} : { effect: { claim, verified } }),
  tRange: { from: 0, to: at },
  at,
});

const DEPS = { runId: 'run_1', projectId: 'acme-web-1234abcd' };

describe('a drive folded into a run', () => {
  it('turns a proved verdict into a passing check', () => {
    const run = driveRunFrom([action(Verified.YES, 'the row disappears')], DEPS);
    expect(run?.checks).toHaveLength(1);
    expect(run?.checks[0]?.status).toBe(Verified.YES);
    expect(run?.checks[0]?.predicate).toBe('the row disappears');
  });

  // Plan-run artifacts named the project "reticle-mcp" (the daemon's own name) when the tab reported
  // no project: the folder it was saved in names it instead.
  it('names the project by its folder when the tab reported none', () => {
    const run = driveRunFrom([action(Verified.YES)], { runId: 'run_2', projectName: 'priya-shop' });
    expect(run?.project.name).toBe('priya-shop');
  });

  // A failed check carries the calls of its window to the run, so its issue can show the request.
  it("carries a failed check's requests as its evidence", () => {
    const call = { method: 'POST', url: '/api/saved-items', status: 200, body: '{}' };
    const failed: JournalAction = {
      ...action(Verified.NO),
      effect: { claim: 'a POST', verified: Verified.NO, net: [call] },
    };
    const run = driveRunFrom([failed], DEPS);
    expect(run?.checks[0]?.evidence).toEqual({ net: [call] });
  });

  // The platform asked for the intent a check proves on the check itself, not guessed by time.
  it('names the intent a check was taken for', () => {
    const run = driveRunFrom(
      [{ ...action(Verified.YES), args: { ref: 'e3', intent: 'saved-items-shows-new-order' } }],
      DEPS,
    );
    expect(run?.checks[0]?.intent).toBe('saved-items-shows-new-order');
    // And the artifact the platform receives keeps it.
    const built = buildVerificationRun(run as VerificationRunInput, () => 0);
    expect(built.checks[0]?.intent).toBe('saved-items-shows-new-order');
    expect(driveRunFrom([action(Verified.YES)], DEPS)?.checks[0]).not.toHaveProperty('intent');
  });

  // An agent that gave no intent left its check titled with engine wording on the platform. The
  // verdict now records a sentence and the part of a conjunction that failed; the run carries both.
  it('carries the sentence and the failed part the verdict recorded', () => {
    const failed: JournalAction = {
      ...action(Verified.NO),
      effect: {
        claim: 'all of (…)',
        verified: Verified.NO,
        intent: 'No PATCH request to /assignee was made',
        intentDerived: true,
        failedPart: 1,
      },
    };
    const check = driveRunFrom([failed], DEPS)?.checks[0];
    expect(check?.intent).toBe('No PATCH request to /assignee was made');
    expect(check?.intentDerived).toBe(true);
    expect(check?.failedPart).toBe(1);
    const built = buildVerificationRun(
      driveRunFrom([failed], DEPS) as VerificationRunInput,
      () => 0,
    );
    expect(built.checks[0]?.failedPart).toBe(1);
    // The agent's own words, from the call, still win.
    const own = driveRunFrom(
      [{ ...failed, args: { intent: 'changing the assignee saves' } }],
      DEPS,
    );
    expect(own?.checks[0]?.intent).toBe('changing the assignee saves');
    expect(own?.checks[0]).not.toHaveProperty('intentDerived');
  });

  it('keeps the action each check came from, so its screenshot can find it', () => {
    const run = driveRunFrom([action(Verified.YES, 'the row disappears', 41)], DEPS);
    expect(run?.checks[0]?.actionId).toBe('c41');
  });

  it('turns a disproved verdict into a failing check, and the run verdict follows', () => {
    const run = driveRunFrom([action(Verified.NO)], DEPS);
    expect(run?.checks[0]?.status).toBe(Verified.NO);
    expect(run === undefined ? undefined : computeVerdict(run).status).toBe(VerdictStatus.FAIL);
  });

  it('ignores actions that recorded no verdict at all — an act proves nothing', () => {
    expect(driveRunFrom([action(undefined), action(Verified.YES)], DEPS)?.checks).toHaveLength(1);
  });

  /**
   * The false-green guard. `unknown` means "I could not tell" and `no-fault` means "nothing was
   * declared to prove", and the product reports both as NOT PROVED.
   *
   * They used to be DROPPED here and counted in a sentence, because the outcome on disk was binary
   * and had no spelling for either. Not proved is not the same as not recorded: a reader of the
   * artifact saw only the verdicts we could spell, so our blind spots left the document and the
   * app's failures stayed in it. Both are written down now, and neither may become a pass.
   */
  describe('verdicts that proved nothing', () => {
    it('writes them down rather than dropping them', () => {
      const run = driveRunFrom([action(Verified.UNKNOWN), action(Verified.NO_FAULT)], DEPS);
      expect(run?.checks.map((c) => c.status)).toEqual([Verified.UNKNOWN, Verified.NO_FAULT]);
    });

    it('says nothing was proved, rather than staying silent', () => {
      const run = driveRunFrom([action(Verified.UNKNOWN), action(Verified.NO_FAULT)], DEPS);
      expect(buildVerificationRun(run as VerificationRunInput, () => 1).verdict.status).toBe(
        VerdictStatus.UNKNOWN,
      );
    });

    it('never counts one as a pass when there were real verdicts alongside it', () => {
      const run = driveRunFrom([action(Verified.YES), action(Verified.UNKNOWN)], DEPS);
      expect(run?.checks).toHaveLength(2);
      // One proved, one not, and nothing failed: PARTIAL, never PASS and never FAIL. It read PASS
      // while the agent's own result block said "not proved · 1 of 2 checks undecided" for the same
      // run, and the dashboard shared it as Passed.
      expect(run === undefined ? undefined : computeVerdict(run).status).toBe(
        VerdictStatus.PARTIAL,
      );
    });

    it('does not let one become a failure', () => {
      const run = driveRunFrom([action(Verified.UNKNOWN), action(Verified.NO)], DEPS);
      expect(run === undefined ? undefined : computeVerdict(run).status).toBe(VerdictStatus.FAIL);
    });

    it('no longer explains itself in prose, because it no longer drops anything', () => {
      const run = driveRunFrom([action(Verified.YES), action(Verified.UNKNOWN)], DEPS);
      expect(run?.trigger.note).not.toContain('undetermined');
    });
  });

  it('produces nothing at all for a session that never verified anything', () => {
    expect(driveRunFrom([], DEPS)).toBeUndefined();
  });

  it('takes its duration from the journal clock, not from wall time', () => {
    const run = driveRunFrom([action(Verified.YES, 'a', 10), action(Verified.NO, 'b', 250)], DEPS);
    expect(run?.durationMs).toBe(250);
  });

  it('carries the project through, or the dashboard row belongs to nobody', () => {
    expect(driveRunFrom([action(Verified.YES)], DEPS)?.project.name).toBe('acme-web-1234abcd');
  });

  it('keeps the source pointer as evidence when the page gave one', () => {
    const withSource: JournalAction = {
      ...action(Verified.YES),
      effect: { claim: 'saved', verified: Verified.YES, source: 'src/Form.tsx:42:8' },
    };
    expect(driveRunFrom([withSource], DEPS)?.checks[0]?.evidence).toEqual({
      source: 'src/Form.tsx:42:8',
    });
  });
});

/**
 * One row per drive, not one per page reload.
 *
 * Session teardown fires on every socket close, and a reconnecting tab keeps its session id and goes
 * on appending to the same journal. A random run id per teardown would publish a row per reload,
 * each a superset of the last, and one drive would look like five overlapping verifications.
 */
describe('the run id for a drive', () => {
  it('is derived from the session, so a re-fold rewrites the same row', () => {
    const id = 'scc5398dc-8e92-4733-bbdd-1787041cb69d';
    expect(driveRunId(id)).toBe(driveRunId(id));
  });

  it('is short: every step screenshot path an agent reads carries it', () => {
    // A uuid session id made the id 43 characters long, and it went into each step's path.
    const id = 'scc5398dc-8e92-4733-bbdd-1787041cb69d';
    expect(driveRunId(id)).toMatch(/^drive-[0-9a-f]{16}$/);
  });

  it('still accepts an old long id as a run id, so older runs stay readable', () => {
    expect(isValidRunId('drive-scc5398dc-8e92-4733-bbdd-1787041cb69d')).toBe(true);
    expect(isValidRunId('3f0c6a7e-2b1d-4c8e-9f3a-5d6e7f8a9b0c')).toBe(true);
  });

  it('separates two sessions, which are two drives', () => {
    expect(driveRunId('s-one')).not.toBe(driveRunId('s-two'));
  });

  it('marks it as a drive, so it cannot collide with a replay run', () => {
    expect(driveRunId('s-one').startsWith('drive-')).toBe(true);
  });

  it('is a safe path segment for a session id that is not one, and stays stable', () => {
    // A session id is a free string on the wire. It must never put `../` into a file path.
    const unsafe = '../../etc/passwd';
    expect(isValidRunId(driveRunId(unsafe))).toBe(true);
    expect(driveRunId(unsafe)).toBe(driveRunId(unsafe));
  });
});

/**
 * What the check READ, carried rather than assumed.
 *
 * Every check this fold ever wrote was stamped `element`, unconditionally, because the journal had
 * no field for it. Checks on the artifacts in this checkout said `element` while their own `grade`
 * in the same object said `net` or `state` — and `channelsRead` routes on `kind`, so a network
 * verdict reached every consumer as a UI verdict.
 */
describe('the kind of evidence a check read', () => {
  const withKind = (kind: string, grade: string): JournalAction => ({
    ...action(Verified.YES),
    effect: { claim: 'the save request goes out', verified: Verified.YES, kind, grade },
  });

  it('reports a net verdict as net, not as an element', () => {
    expect(driveRunFrom([withKind(PredicateKind.NET, 'net')], DEPS)?.checks[0]?.kind).toBe(
      PredicateKind.NET,
    );
  });

  it('leaves it absent when the journal never recorded one — a missing field, never a wrong one', () => {
    expect(driveRunFrom([action(Verified.YES)], DEPS)?.checks[0]?.kind).toBeUndefined();
  });
});

/*
 * A Pay-button check that wanted `enabled` and saw "present, visible, disabled" became an issue
 * whose Actual read "It did not happen while the check waited": the run kept the verdict and not
 * what it saw, so nothing downstream could say it.
 */
describe('what a failed check wanted and saw', () => {
  it('rides on the check as expected and observed, its source in the evidence', () => {
    const run = driveRunFrom(
      [
        {
          ...action(Verified.NO),
          effect: {
            claim: 'an element matching {"testid":"pay"} in state \'enabled\'',
            verified: Verified.NO,
            source: 'src/main.ts:12',
            expected: 'an element matching {"testid":"pay"} in state \'enabled\'',
            observed: 'present, visible, disabled',
          },
        },
      ],
      DEPS,
    );
    expect(run?.checks[0]).toMatchObject({
      expected: 'an element matching {"testid":"pay"} in state \'enabled\'',
      observed: 'present, visible, disabled',
      evidence: { source: 'src/main.ts:12' },
    });
  });
});

describe('the agent a drive is credited to', () => {
  it('is the MCP client that made the calls, not the generic author', () => {
    const run = driveRunFrom([{ ...action(Verified.YES), agent: 'claude-code' }], DEPS);
    expect(run?.agent.id).toBe('claude-code');
  });

  it('stays the generic author when two clients drove the same tab — never a guess', () => {
    const run = driveRunFrom(
      [
        { ...action(Verified.YES), agent: 'claude-code' },
        { ...action(Verified.YES), agent: 'cursor' },
      ],
      DEPS,
    );
    expect(run?.agent.id).toBe('reticle-mcp');
  });
});

describe('a Harness drive in the same tab', () => {
  const by = { harness: 'h1', driver: 'server', persona: 'a merchant refunds a payment' };
  const harness = (verified: Verified, at: number): JournalAction => ({
    ...action(verified, 'a request POST matching refund', at),
    drivenBy: by,
  });

  it('becomes its own run, named for its journey and credited to the Harness', () => {
    const runs = driveRunsFrom(
      [
        action(Verified.YES, 'agent proved this', 10),
        harness(Verified.YES, 40),
        harness(Verified.NO, 70),
      ],
      DEPS,
    );
    expect(runs.map((run) => run.runId)).toEqual(['run_1', 'harness-h1']);
    const [agent, drive] = runs;
    expect(agent?.checks.map((check) => check.predicate)).toEqual(['agent proved this']);
    expect(drive?.agent.id).toBe(harnessAgentId('server'));
    expect(drive?.flows).toEqual([{ name: by.persona, status: 'fail', steps: 2, durationMs: 30 }]);
    expect(drive?.checks).toHaveLength(2);
  });

  // Re-check: a drive nobody named a journey for was titled "Harness drive" on every screen.
  it('is never titled "Harness drive" when nobody named its journey', () => {
    const unnamed = { harness: 'h0', driver: 'server' };
    const runs = driveRunsFrom([{ ...action(Verified.YES, 'saved', 5), drivenBy: unnamed }], DEPS);
    expect(runs[0]?.flows[0]?.name).not.toBe('Harness drive');
  });

  /*
   * A re-drive: the Harness saved "Order 7" (POST held), the app emptied the field, and the driver
   * pressed Save again declaring the same POST; that second press was filed as a high-severity issue
   * against the app. The same control, the same claim, after it held, is the Harness's own extra
   * press: undecided, never a failure of the app.
   */
  it('does not fail the app on its own second press of a control whose claim already held', () => {
    const save = (verified: Verified, at: number): JournalAction => ({
      ...harness(verified, at),
      args: { ref: 'e138', action: 'click' },
      drivenBy: { ...by, harness: 'h-repress' },
    });
    const runs = driveRunsFrom([save(Verified.YES, 40), save(Verified.NO, 70)], DEPS);
    const drive = runs.find((run) => 'harness-h-repress' === run.runId);
    expect(drive?.checks.map((check) => check.status)).toEqual([Verified.YES, Verified.UNKNOWN]);
    expect(drive?.flows[0]?.status).not.toBe('fail');
  });

  /** A drive that saw "Invalid email or password" and never reached its goal synced as "Proved". */
  it('is not proved when the drive did not reach its goal, though every check held', () => {
    const missed = { ...by, harness: 'h-goal' };
    noteHarnessGoal('h-goal', false);
    const runs = driveRunsFrom(
      [
        { ...harness(Verified.YES, 40), drivenBy: missed },
        { ...harness(Verified.YES, 70), drivenBy: missed },
      ],
      DEPS,
    );
    expect(runs.find((run) => 'harness-h-goal' === run.runId)?.flows[0]?.status).toBe('skipped');
  });

  /*
   * Two-way testing reaches the platform on the run: a goal the agent proved and the Harness could
   * not find is filed there as a discoverability finding, so the comparison rides on the artifact.
   */
  it('carries how its goals compared with the agent, through the artifact schema', () => {
    const compared = { ...by, harness: 'h-two-way' };
    const disparity = [
      {
        goal: 'Reopened by',
        kind: DisparityKind.DISCOVERABILITY,
        agent: { verified: Verified.YES, claim: "text containing 'Reopened by'" },
        harness: {
          verified: Verified.UNKNOWN,
          found: false,
          searched: ['/issues'],
          gaveUpAt: '/issues',
        },
      },
    ];
    noteHarnessDisparity('h-two-way', disparity);
    const [run] = driveRunsFrom([{ ...harness(Verified.YES, 40), drivenBy: compared }], DEPS);
    expect(run?.disparity).toEqual(disparity);
    expect(buildVerificationRun(run as VerificationRunInput, () => 1).disparity).toEqual(disparity);
  });

  /** A user drive with 0 failed and 2 undecided, its goal judged missed, synced as a failure. */
  it('never syncs undecided checks as a failure, goal missed or not', () => {
    const open = { ...by, harness: 'h-open' };
    noteHarnessGoal('h-open', false);
    const runs = driveRunsFrom(
      [
        { ...harness(Verified.UNKNOWN, 40), drivenBy: open },
        { ...harness(Verified.UNKNOWN, 70), drivenBy: open },
      ],
      DEPS,
    );
    expect(runs.find((run) => 'harness-h-open' === run.runId)?.flows[0]?.status).toBe('skipped');
  });

  /*
   * The driver declared that a Mine/Team toggle would leave /overview; it did not, and a run whose
   * every goal was met synced as failed. Its own wrong guess is undecided, not a failed check.
   */
  it("never counts the driver's missed route guess as a failed check", () => {
    const guess = { ...by, harness: 'h-guess' };
    const missed: JournalAction = {
      ...action(Verified.NO, "the absence of a route change containing '/overview'", 70),
      effect: {
        claim: "the absence of a route change containing '/overview'",
        verified: Verified.NO,
        kind: 'not',
      },
      drivenBy: guess,
    };
    const runs = driveRunsFrom([{ ...harness(Verified.YES, 40), drivenBy: guess }, missed], DEPS);
    const drive = runs.find((run) => 'harness-h-guess' === run.runId);
    expect(drive?.flows[0]?.status).toBe('pass');
    expect(drive?.checks.map((check) => check.status)).toEqual([Verified.YES, Verified.UNKNOWN]);
  });

  it('leaves a session the Harness never touched exactly one run', () => {
    expect(driveRunsFrom([action(Verified.YES)], DEPS).map((run) => run.runId)).toEqual(['run_1']);
  });
});

/**
 * One tab, several agent sessions, and the Harness driving in between. An agent whose one check
 * held ended on "failed · 14 of 99 checks did not hold" — the tab's Harness drives folded in — and
 * every agent session in that tab wrote the same run id, so a later end overwrote an earlier run.
 */
describe('an agent session ending in a tab the Harness also drove', () => {
  const by = { harness: 'h9', driver: 'server', persona: 'p' };
  const own = (verified: Verified, at: number): JournalAction =>
    action(verified, `agent claim ${String(at)}`, at);
  const theirs = (at: number): JournalAction => ({ ...action(Verified.NO, 'h', at), drivenBy: by });

  it("folds only the agent's own calls since its last end, each session under its own run", () => {
    const tab = 'tab-ends';
    const first = endAgentSession(tab, [own(Verified.YES, 1), theirs(2), theirs(3)], 100);
    expect(first.actions.map((a) => a.at)).toEqual([1]);
    expect(first.runId).toBe(driveRunId(tab));
    expect(first.wallMs).toBe(100);

    const second = endAgentSession(
      tab,
      [own(Verified.YES, 1), theirs(2), theirs(3), own(Verified.NO, 120)],
      250,
    );
    expect(second.actions.map((a) => a.at)).toEqual([120]);
    expect(second.runId).not.toBe(first.runId);
    expect(second.wallMs).toBe(150);
    // What the agent drives next belongs to the session after these two.
    expect(agentRunId(tab)).not.toBe(second.runId);
  });

  /*
   * Persona drive: a session that drove three steps over ~10s ended "1.2s". The tab's clock restarts
   * with every page load (the journal is stamped on it), so "end minus last end" measured only the
   * time since the last reload.
   */
  it('times a session across the reloads it caused, never only since the last one', () => {
    const step = (from: number, at: number): JournalAction => ({
      ...action(Verified.YES, `step ${String(at)}`, at),
      tRange: { from, to: at },
    });
    const ended = endAgentSession(
      'tab-reloads',
      [step(0, 3000), step(3000, 8000), step(200, 1000)],
      1200,
    );
    expect(ended.wallMs).toBe(9000);
  });

  // Persona drive: a second session on the same tab, after a reload, ended "Metrics: -8.3s".
  it('never times a second session after a reload as negative', () => {
    const tab = 'tab-negative';
    endAgentSession(tab, [action(Verified.YES, 'first', 9000)], 9500);
    const second = endAgentSession(
      tab,
      [
        action(Verified.YES, 'first', 9000),
        { ...action(Verified.NO, 'second', 400), tRange: { from: 300, to: 400 } },
      ],
      1200,
    );
    expect(second.wallMs).toBe(900);
  });

  it("writes each agent session's run under its own id", () => {
    const runs = driveRunsFrom([own(Verified.YES, 1), theirs(2), own(Verified.NO, 3)], {
      ...DEPS,
      agentEnds: [1],
    });
    expect(runs.map((r) => r.runId)).toEqual(['run_1', 'run_1-2', 'harness-h9']);
    expect(runs[0]?.checks.map((c) => c.status)).toEqual([Verified.YES]);
    expect(runs[1]?.checks.map((c) => c.status)).toEqual([Verified.NO]);
  });
});

/**
 * A driven journey's run read "Took 0 ms" on the dashboard: the tab's journal held only the grade's
 * one assert for it (the drive itself ran elsewhere), so the span of its actions was nothing. The
 * Harness times its own drive, on the injected clock, and the run carries that.
 */
describe("a Harness run's duration", () => {
  it('is the time the Harness measured, not the span of the actions one tab saw', () => {
    noteHarnessSpan('h-span', 4_200);
    const by = { harness: 'h-span', driver: 'server', persona: 'p' };
    const [run] = driveRunsFrom([{ ...action(Verified.YES, 'x', 40), drivenBy: by }], DEPS);
    expect(run?.durationMs).toBe(4_200);
    expect(run?.flows[0]?.durationMs).toBe(4_200);
  });
});

/*
 * The platform linked an intent's proof to its run by time, a guess: a check that proves an intent
 * now names the run it lands in. The same run a call's screenshot is filed under.
 */
describe('the run a call lands in', () => {
  it("is the agent session's run in its tab, and the Harness drive's when one drives", async () => {
    expect(runIdOfCall('tab-call')).toBe(agentRunId('tab-call'));
    const harness = await runDrivenBy({ harness: 'h1', driver: 'server' }, () =>
      Promise.resolve(runIdOfCall('tab-call')),
    );
    expect(harness).toBe(harnessRunId('h1'));
  });
});

// Re-check: the run an agent session ended was written only when its tab disconnected, so
// the end's "Run on the dashboard" link answered not_found until the lease was released.
describe('an agent session ending', () => {
  it('asks for its runs to be written again, so the ended run reaches the disk', () => {
    let told = 0;
    const off = onHarnessNoted(() => {
      told += 1;
    });
    endAgentSession('tab-written', [action(Verified.YES, 'saved', 1)], 10);
    off();
    expect(told).toBe(1);
  });
});
