/**
 * The replication protocol, driven against a scripted server.
 *
 * The properties worth locking are all about NOT COSTING ANYTHING and NOT LOSING ANYTHING: a quiet
 * machine must send nothing, a machine that has been offline must catch up without re-sending its
 * history, and no failure anywhere in the cycle may touch the local record — which is the only copy
 * that was ever authoritative.
 */
import { describe, expect, it } from 'vitest';
import { FlowErrorCode, SYNC_BATCH_LIMITS } from '@reticlehq/core';
import {
  describeSync,
  runSyncCycle,
  type CloudSyncState,
  type PulledIssues,
  type SyncSource,
} from './sync-cycle.js';
import { hashPayload } from './sync-hash.js';

const NOW = 1_700_000_000_000;

const IMPACT = { counts: { calls: 3, failed: 1 }, days: [] };

/** A scripted server: hand it the bodies to answer with, read back what it was asked. */
/**
 * What the real handler answers when the script does not say: a `runs` result for every request,
 * accepting each run it was sent, as the platform's sync route does. It used to answer `{}`, which no
 * real server sends, and which hid that a 200 saying nothing about runs was recorded as delivered.
 */
function realAnswer(body: string | undefined): unknown {
  const parsed: unknown = body === undefined ? {} : JSON.parse(body);
  const runs =
    'object' === typeof parsed && null !== parsed ? (parsed as { runs?: unknown }).runs : undefined;
  return { runs: { accepted: Array.isArray(runs) ? runs.length : 0, rejected: [] } };
}

function server(script: {
  status?: unknown;
  statusCode?: number;
  sync?: unknown;
  syncCode?: number;
  pull?: unknown;
  pullCode?: number;
  throwOn?: string;
}) {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  // Not `async`: a scripted server answers instantly, and a promise returned by hand keeps the
  // signature honest without a lint suppression. A synchronous throw still lands in the cycle's
  // try/catch, which is the path the offline test exercises.
  const request = (
    url: string,
    init: { method: string; body?: string },
  ): Promise<{ status: number; text: string }> => {
    calls.push({
      url,
      method: init.method,
      ...(init.body === undefined ? {} : { body: JSON.parse(init.body) }),
    });
    if (script.throwOn !== undefined && url.includes(script.throwOn)) {
      throw new Error('ECONNREFUSED');
    }
    if (url.includes('/v1/sync/status')) {
      return Promise.resolve({
        status: script.statusCode ?? 200,
        text: JSON.stringify(script.status ?? {}),
      });
    }
    if (url.includes('/v1/sync/pull')) {
      return Promise.resolve({
        status: script.pullCode ?? 200,
        text: JSON.stringify(script.pull ?? { triage: [] }),
      });
    }
    return Promise.resolve({
      status: script.syncCode ?? 200,
      text: JSON.stringify(script.sync ?? realAnswer(init.body)),
    });
  };

  return { request, calls };
}

function source(over: Partial<SyncSource> = {}): SyncSource {
  return {
    runs: () => [],
    flows: () => [],
    capsules: () => [],
    derived: () => undefined,
    ...over,
  };
}

/** Captures what the cycle wrote, so a test can assert the machine's own bookkeeping. */
function sink() {
  const written: { issues?: PulledIssues; state?: CloudSyncState } = {};
  return {
    written,
    sink: {
      writeIssues: (i: PulledIssues): void => {
        written.issues = i;
      },
      writeState: (s: CloudSyncState): void => {
        written.state = s;
      },
    },
  };
}

const cycle = async (
  script: Parameters<typeof server>[0],
  src: SyncSource = source(),
  state: CloudSyncState = {},
) => {
  const s = server(script);
  const k = sink();
  const report = await runSyncCycle({
    config: { url: 'https://cloud.test', apiKey: 'rk_test' },
    source: src,
    sink: k.sink,
    state,
    now: () => NOW,
    request: s.request,
  });
  return { report, calls: s.calls, written: k.written };
};

describe('a quiet machine costs nothing', () => {
  it('sends no bundle at all when the server already has everything', async () => {
    const { report, calls } = await cycle(
      { status: { knownRunIds: ['a'], stateHashes: { impact: hashPayload(IMPACT) } } },
      source({
        runs: () => [{ runId: 'a', payload: { runId: 'a' } }],
        derived: (kind) => ('impact' === kind ? IMPACT : undefined),
      }),
      // A machine that has synced before: it delivered this exact run.
      { sentRunHashes: { a: hashPayload({ runId: 'a' }) } },
    );
    expect(report.ok).toBe(true);
    expect(report.runsSent).toBe(0);
    expect(report.derivedSent).toEqual([]);
    expect(calls.some((c) => 'POST' === c.method)).toBe(false);
  });

  it('still PULLS when there is nothing to push — the quiet machine is the one being triaged on', async () => {
    const { calls } = await cycle({ status: {} });
    expect(calls.some((c) => c.url.includes('/v1/sync/pull'))).toBe(true);
  });

  it('says so in words a human can read, and distinguishes quiet from empty', async () => {
    /*
     * A machine that has recorded something and already pushed it is QUIET, and says the quiet
     * thing. A repo holding no artifacts at all is a different situation wearing the same words —
     * usually an app announcing no projectId, whose runs are pooling under another root — so it
     * gets its own sentence. Conflating them cost a full investigation: a linked repo answered
     * "nothing to send" straight after two verdicts had been driven through it.
     */
    // "Already pushed" includes this machine's own record of the push. Without it the run is sent
    // again, and only a fake server answering `{}` used to make that look like nothing was sent.
    const quiet = await cycle(
      { status: { knownRunIds: ['a'], stateHashes: { impact: hashPayload(IMPACT) } } },
      source({
        runs: () => [{ runId: 'a', payload: { runId: 'a' } }],
        derived: (kind) => ('impact' === kind ? IMPACT : undefined),
      }),
      { sentRunHashes: { a: hashPayload({ runId: 'a' }) } },
    );
    expect(describeSync(quiet.report)).toBe('nothing to send');

    const empty = await cycle({ status: {} });
    expect(describeSync(empty.report)).toContain('nothing recorded');
  });
});

/**
 * What the user is told when the server took the push and threw all of it away.
 *
 * The summary counted rejections but printed the reason for none of them, and — because it builds
 * the sentence from what was ACCEPTED — a bundle that was entirely refused read as "nothing to
 * send, 3 rejected". Both halves wrong in the same breath: something was very much sent, and the
 * one fact that would let anybody act (why) was the one fact dropped. This is the shape a version
 * skew takes in the field, where an older client's payloads are refused one by one.
 */
/**
 * "Nothing to send" answers two very different questions with one sentence.
 *
 * Healthy: everything local has already been pushed, so this cycle is a no-op — the normal steady
 * state. Broken: this repo has recorded NOTHING, because the app announces no project and its runs
 * are pooling into some other root entirely. The second is a silent data-loss bug and it wore the
 * first one's words.
 *
 * That ambiguity cost a full investigation here: a linked repo answered "nothing to send"
 * immediately after two verdicts had been driven through it, and the message gave no way to tell
 * which of the two situations it was.
 */
describe('an empty repo and an up-to-date repo do not say the same thing', () => {
  const line = (over: Partial<Parameters<typeof describeSync>[0]>): string =>
    describeSync({
      ok: true,
      runsSent: 0,
      runsRejected: [],
      flowsSent: 0,
      capsulesSent: 0,
      derivedSent: [],
      refused: [],
      held: [],
      notRetried: [],
      setsNotRetried: [],
      pulled: 0,
      morePending: false,
      ...over,
    });

  it('says nothing is RECORDED when the repo holds no artifacts at all', () => {
    expect(line({ localIsEmpty: true })).toContain('nothing recorded');
  });

  it('still says nothing to send when there is local data, all of it already pushed', () => {
    // The steady state must stay quiet — a warning every cycle is a warning nobody reads.
    expect(line({ localIsEmpty: false })).toBe('nothing to send');
  });

  it('says nothing about emptiness when something actually went', () => {
    expect(line({ localIsEmpty: false, runsSent: 2 })).toContain('2 run(s)');
    expect(line({ localIsEmpty: false, runsSent: 2 })).not.toContain('nothing');
  });
});

describe('when the server refuses what was pushed', () => {
  const refused = (rejected: Array<{ index: number; reason: string }>): string =>
    describeSync({
      // A cycle whose artifacts were all refused is not an ok cycle; the fixture says so rather
      // than pinning the wording against a report shape the protocol can no longer produce.
      ok: false,
      runsSent: 0,
      runsRejected: rejected,
      flowsSent: 0,
      capsulesSent: 0,
      derivedSent: [],
      refused: [],
      held: [],
      notRetried: [],
      setsNotRetried: [],
      pulled: 0,
      morePending: false,
    });

  it('does not claim there was nothing to send', () => {
    const line = refused([{ index: 0, reason: 'unknown field "verdicts"' }]);
    expect(line).not.toContain('nothing to send');
  });

  it('names the reason, not just the count — a number alone is not actionable', () => {
    const line = refused([{ index: 0, reason: 'unknown field "verdicts"' }]);
    expect(line).toContain('unknown field "verdicts"');
  });

  it('gives one reason and the remaining count when several disagree', () => {
    // A run per line would bury the summary. One example plus a count is enough to act on, and
    // `reticle sync` prints the full list separately.
    const line = refused([
      { index: 0, reason: 'unknown field "verdicts"' },
      { index: 1, reason: 'unknown field "verdicts"' },
      { index: 2, reason: 'missing runId' },
    ]);
    expect(line).toContain('unknown field "verdicts"');
    expect(line).toContain('3');
  });

  it('still reports what DID land when only some were refused', () => {
    const line = describeSync({
      ok: false,
      runsSent: 2,
      runsRejected: [{ index: 2, reason: 'missing runId' }],
      flowsSent: 0,
      capsulesSent: 0,
      derivedSent: [],
      refused: [],
      held: [],
      notRetried: [],
      setsNotRetried: [],
      pulled: 0,
      morePending: false,
    });
    expect(line).toContain('2 run(s)');
    expect(line).toContain('missing runId');
  });
});

/**
 * A push the server threw away is a FAILED push, and `ok` is the only field that says so.
 *
 * Reported from the field: `reticle push` answered `{"ok":true, "sent":{"runs":0, …,
 * "rejected":[…]}}` and exited 0 while the dashboard had refused every artifact it was handed. The
 * rejection list was right there in the payload and the summary line named the reason, but `ok` was
 * built from "the cycle completed" rather than from what the cycle achieved — so a scripted sync or
 * a CI step, which reads one boolean and an exit code, saw a healthy push with nothing to send.
 *
 * The rule is any rejection, not only a total one. A refused artifact never lands and is re-offered
 * on every cycle forever, so a caller that cannot see it has no way to learn that its dashboard is
 * missing evidence it believes it sent.
 */
describe('a refused artifact is a failed push, not a quiet one', () => {
  const twoRuns = source({
    runs: () => [
      { runId: 'a', payload: { runId: 'a' } },
      { runId: 'b', payload: { runId: 'b' } },
    ],
  });
  const SCHEMA_REFUSAL = 'run artifact failed validation: schemaVersion: expected 1';

  it('is not ok when the server accepted nothing and refused everything', async () => {
    const { report } = await cycle(
      {
        status: {},
        sync: {
          runs: {
            accepted: 0,
            rejected: [
              { index: 0, reason: SCHEMA_REFUSAL },
              { index: 1, reason: SCHEMA_REFUSAL },
            ],
          },
        },
      },
      twoRuns,
    );
    expect(report.ok, 'nothing landed, so the push did not succeed').toBe(false);
    expect(report.runsSent).toBe(0);
  });

  it('keeps every rejection and its reason, so the caller learns WHAT to fix', async () => {
    const { report } = await cycle(
      {
        status: {},
        sync: {
          runs: {
            accepted: 0,
            rejected: [
              { index: 0, reason: SCHEMA_REFUSAL },
              { index: 1, reason: SCHEMA_REFUSAL },
            ],
          },
        },
      },
      twoRuns,
    );
    // Not ok is the signal; the list is what makes it actionable. Losing either one re-creates half
    // of the defect — a caller that knows something failed but not what, or the reverse.
    expect(report.runsRejected).toEqual([
      { index: 0, reason: SCHEMA_REFUSAL },
      { index: 1, reason: SCHEMA_REFUSAL },
    ]);
    expect(describeSync(report)).toContain(SCHEMA_REFUSAL);
  });

  it('is not ok on a PARTIAL refusal, and still reports what landed', async () => {
    const { report } = await cycle(
      {
        status: {},
        sync: { runs: { accepted: 1, rejected: [{ index: 1, reason: SCHEMA_REFUSAL }] } },
      },
      twoRuns,
    );
    expect(report.ok, 'one artifact was refused, so not everything was pushed').toBe(false);
    // Partial success is preserved rather than flattened into a failure: the run that DID land is
    // still counted, and the summary still says so.
    expect(report.runsSent).toBe(1);
    expect(describeSync(report)).toContain('1 run(s)');
  });

  it('a refused push does not abort the pull, and the decisions still arrive', async () => {
    const { report, written } = await cycle(
      {
        status: {},
        sync: { runs: { accepted: 0, rejected: [{ index: 0, reason: SCHEMA_REFUSAL }] } },
        pull: {
          triage: [{ fingerprint: 'fp1', status: 'resolved', title: 'x', at: 5 }],
          cursor: '5:fp1',
        },
      },
      twoRuns,
    );
    // The two halves are independent. A dashboard refusing this build's artifacts is exactly the
    // dashboard somebody is triaging on, so dropping the collected decisions would cost twice.
    expect(report.pulled).toBe(1);
    expect(written.issues?.triage['fp1']?.status).toBe('resolved');
    expect(written.state?.cursor).toBe('5:fp1');
  });

  it('stays ok when the server accepted everything it was handed', async () => {
    const { report } = await cycle(
      { status: {}, sync: { runs: { accepted: 2, rejected: [] } } },
      twoRuns,
    );
    expect(report.ok).toBe(true);
    expect(report.runsSent).toBe(2);
  });

  it('stays ok on a cycle that sent nothing at all', async () => {
    // The steady state, and the one that must not be dragged red by this rule: nothing was offered,
    // so nothing could be refused, and a quiet machine is healthy rather than broken.
    const { report } = await cycle({ status: { knownRunIds: ['a', 'b'] } }, twoRuns);
    expect(report.ok).toBe(true);
    expect(report.runsRejected).toEqual([]);
  });

  it('reads a server that says nothing about rejections as none, never as a refusal', async () => {
    // An older cloud answers with an accepted count and no `rejected` key at all. That must stay ok
    // — the same compatibility rule the capsule field already obeys.
    const { report } = await cycle({ status: {}, sync: { runs: { accepted: 2 } } }, twoRuns);
    expect(report.ok).toBe(true);
    expect(report.runsRejected).toEqual([]);
  });
});

/**
 * How each page normally behaves (envelopes) and how strong each flow's checks are (assertion tiers)
 * were kept only on the machine that measured them. They are what a server needs to tell a page that
 * drifted from one that always behaved that way, so they ride along like the other derived records.
 */
describe('the page baselines and check strengths leave the laptop', () => {
  const ENVELOPES = {
    version: 1,
    routes: { '/issues': { route: '/issues', samples: 3, stats: {} } },
  };
  const TIERS = { version: 1, flows: { 'sign-in': { steps: [{ step: 0 }], sources: [] } } };
  const withKnowledge = source({
    derived: (kind) =>
      'envelopes' === kind ? ENVELOPES : 'assertion-tiers' === kind ? TIERS : undefined,
  });

  it('sends envelopes and assertion tiers the server does not hold', async () => {
    const { calls } = await cycle(
      { status: { stateHashes: { envelopes: null, 'assertion-tiers': null } } },
      withKnowledge,
    );
    const push = calls.find((c) => 'POST' === c.method);
    expect(push?.body).toMatchObject({ envelopes: ENVELOPES, 'assertion-tiers': TIERS });
  });

  it('sends neither when the server already holds the same content', async () => {
    const { calls } = await cycle(
      {
        status: {
          knownRunIds: [],
          stateHashes: {
            envelopes: hashPayload(ENVELOPES),
            'assertion-tiers': hashPayload(TIERS),
          },
        },
      },
      withKnowledge,
    );
    expect(calls.some((c) => 'POST' === c.method)).toBe(false);
  });
});

describe('it sends only the difference', () => {
  it('skips runs the server names and sends the rest', async () => {
    const { report, calls } = await cycle(
      { status: { knownRunIds: ['old'] }, sync: { runs: { accepted: 1, rejected: [] } } },
      source({
        runs: () => [
          { runId: 'old', payload: { runId: 'old' } },
          { runId: 'new', payload: { runId: 'new' } },
        ],
      }),
      { sentRunHashes: { old: hashPayload({ runId: 'old' }) } },
    );
    const post = calls.find((c) => 'POST' === c.method);
    expect((post?.body as { runs: Array<{ runId: string }> }).runs).toEqual([{ runId: 'new' }]);
    expect(report.runsSent).toBe(1);
  });

  /*
   * The server is allowed to answer "here are the ids I hold, and there are more than I listed".
   * Until now the client read the short list as the whole truth, so every run past the server's page
   * was absent from `knownRunIds`, was treated as unsent, and was uploaded again — on every cycle,
   * for as long as the project kept enough runs to truncate the list. The field was declared on the
   * status response and read nowhere.
   *
   * The machine's own record of what the server CONFIRMED accepting is what fills the gap, and it
   * fills it only when the server says the gap is there. A complete list is a complete answer: a run
   * missing from one is genuinely missing, and must be re-sent.
   */
  it('does not re-send a confirmed run when the server truncates its list', async () => {
    const { calls } = await cycle(
      { status: { knownRunIds: ['a'], truncated: true } },
      source({
        runs: () => [
          { runId: 'a', payload: { runId: 'a' } },
          { runId: 'b', payload: { runId: 'b' } },
        ],
      }),
      {
        sentRunIds: ['b'],
        sentRunHashes: { a: hashPayload({ runId: 'a' }), b: hashPayload({ runId: 'b' }) },
      },
    );
    expect(calls.some((c) => 'POST' === c.method)).toBe(false);
  });

  it('still re-sends a run the server leaves out of a COMPLETE list', async () => {
    const { calls } = await cycle(
      { status: { knownRunIds: ['a'] }, sync: { runs: { accepted: 1, rejected: [] } } },
      source({
        runs: () => [
          { runId: 'a', payload: { runId: 'a' } },
          { runId: 'b', payload: { runId: 'b' } },
        ],
      }),
      { sentRunIds: ['b'], sentRunHashes: { a: hashPayload({ runId: 'a' }) } },
    );
    const post = calls.find((c) => 'POST' === c.method);
    expect((post?.body as { runs: Array<{ runId: string }> }).runs).toEqual([{ runId: 'b' }]);
  });

  it('remembers what the server accepted, and forgets runs that are gone', async () => {
    const { written } = await cycle(
      { status: { knownRunIds: ['a'] }, sync: { runs: { accepted: 1, rejected: [] } } },
      source({
        runs: () => [
          { runId: 'a', payload: { runId: 'a' } },
          { runId: 'b', payload: { runId: 'b' } },
        ],
      }),
      { sentRunIds: ['evicted-long-ago'] },
    );
    expect(written.state?.sentRunIds).toEqual(['a', 'b']);
  });

  it('never trusts a rejected run as sent', async () => {
    const { written } = await cycle(
      {
        status: { knownRunIds: [] },
        sync: { runs: { accepted: 0, rejected: [{ index: 0, reason: 'missing runId' }] } },
      },
      source({ runs: () => [{ runId: 'bad', payload: {} }] }),
    );
    expect(written.state?.sentRunIds).toEqual([]);
  });

  /* A malformed record on disk must read as "it knows nothing", never as "it knows this". */
  it('ignores a remembered list that is not a list of strings', async () => {
    const { calls } = await cycle(
      { status: { knownRunIds: [], truncated: true } },
      source({ runs: () => [{ runId: 'b', payload: { runId: 'b' } }] }),
      { sentRunIds: 'b' as unknown as string[] },
    );
    expect(calls.some((c) => 'POST' === c.method)).toBe(true);
  });

  it('skips a derived record whose hash has not moved', async () => {
    const { report } = await cycle(
      { status: { stateHashes: { impact: hashPayload(IMPACT), flake: null } } },
      source({ derived: (kind) => ('impact' === kind ? IMPACT : undefined) }),
    );
    expect(report.derivedSent).toEqual([]);
  });

  it('sends it the moment the record actually changes', async () => {
    const { report } = await cycle(
      {
        status: { stateHashes: { impact: hashPayload(IMPACT) } },
        sync: { state: { impact: 'accepted' } },
      },
      source({ derived: (kind) => ('impact' === kind ? { ...IMPACT, changed: true } : undefined) }),
    );
    expect(report.derivedSent).toEqual(['impact']);
  });

  it('sends a record the server has never seen', async () => {
    const { report } = await cycle(
      { status: { stateHashes: { impact: null } }, sync: { state: { impact: 'accepted' } } },
      source({ derived: (kind) => ('impact' === kind ? IMPACT : undefined) }),
    );
    expect(report.derivedSent).toEqual(['impact']);
  });

  // Flows used to ride along only when something else moved, so a flow saved or edited with no new
  // run never reached the platform. Found syncing a real repo end to end: 23 flows, "nothing to send".
  it('sends a changed flow set on its own, once, and not again while it is unchanged', async () => {
    const src = source({ flows: () => [{ name: 'sign-in' }] });
    const first = await cycle(
      { status: { knownRunIds: [] }, sync: { flows: { accepted: 1 } } },
      src,
    );
    expect(first.calls.some((c) => 'POST' === c.method)).toBe(true);
    expect(first.report.flowsSent).toBe(1);
    const second = await cycle({ status: { knownRunIds: [] } }, src, first.written.state);
    expect(second.calls.some((c) => 'POST' === c.method)).toBe(false);
  });

  // Measured against a platform that reads only flow version 1: every flow was refused on the first
  // push, and the second push said "nothing to send" and cleared the error, so nothing showed that
  // the dashboard had none of the project's flows.
  it('keeps a refused flow set visible, cycle after cycle, without resending it', async () => {
    const src = source({ flows: () => [{ name: 'sign-in', version: 2 }] });
    const refusing = {
      status: { knownRunIds: [] },
      sync: { flows: { accepted: 0, rejected: [{ index: 0, reason: 'expected version 1' }] } },
    };
    const first = await cycle(refusing, src);
    expect(first.report.ok).toBe(false);
    const second = await cycle({ status: { knownRunIds: [] } }, src, first.written.state);
    expect(second.calls.some((c) => 'POST' === c.method)).toBe(false);
    expect(second.report.ok).toBe(false);
    expect(describeSync(second.report)).toContain('refused, not retried: 1 flow(s)');
    expect(describeSync(second.report)).toContain('expected version 1');
    expect(second.written.state?.lastError).toContain('expected version 1');
  });

  it('offers a refused flow set again once the platform says it reads more', async () => {
    const src = source({ flows: () => [{ name: 'sign-in', version: 2 }] });
    const first = await cycle(
      {
        status: { knownRunIds: [] },
        sync: { flows: { accepted: 0, rejected: [{ index: 0, reason: 'expected version 1' }] } },
      },
      src,
    );
    const upgraded = await cycle(
      {
        status: {
          knownRunIds: [],
          accepts: { flowVersions: [1, 2], runVersions: [1], derived: [] },
        },
        sync: { flows: { accepted: 1 } },
      },
      src,
      first.written.state,
    );
    expect(upgraded.calls.some((c) => 'POST' === c.method)).toBe(true);
    expect(upgraded.report.flowsSent).toBe(1);
    expect(upgraded.report.ok).toBe(true);
  });

  it('sends the flow set again once a flow in it changes', async () => {
    const first = await cycle(
      { status: { knownRunIds: [] }, sync: { flows: { accepted: 1 } } },
      source({ flows: () => [{ name: 'sign-in', steps: [] }] }),
    );
    const edited = await cycle(
      { status: { knownRunIds: [] }, sync: { flows: { accepted: 1 } } },
      source({ flows: () => [{ name: 'sign-in', steps: [{ action: 'click' }] }] }),
      first.written.state,
    );
    expect(edited.calls.some((c) => 'POST' === c.method)).toBe(true);
  });

  /*
   * A bug capsule is the only artifact that lets somebody else make the defect happen again.
   *
   * A verdict count tells a dashboard THAT something broke. The capsule carries the minimal failing
   * flow and its blast radius — the requests and store keys the action touched without declaring
   * them — which is what turns a number on a dashboard into something a teammate can fix.
   */
  it('carries capsules once something else IS moving', async () => {
    const { calls } = await cycle(
      { status: {}, sync: { runs: { accepted: 1 } } },
      source({
        runs: () => [{ runId: 'r', payload: { runId: 'r' } }],
        capsules: () => [{ id: 'c1', summary: 'submit did nothing' }],
      }),
    );
    const post = calls.find((c) => 'POST' === c.method);
    expect((post?.body as { capsules: unknown[] }).capsules).toEqual([
      { id: 'c1', summary: 'submit did nothing' },
    ]);
  });

  /*
   * The field complaint this protocol has to answer: issues that never reach the dashboard.
   *
   * The reported shape is "agents forget to sync". They cannot — nothing here is agent-driven — so
   * the real risk is a bug found in a session that produced NO verification run, which is the
   * ordinary shape of exploring an app and hitting a defect. The capsule then rides on the impact
   * record moving rather than on a run, and the test above proves the run case only.
   *
   * If this ever goes red, a defect somebody found is sitting on their laptop and the dashboard
   * says nothing broke — silently, because a capsule that is not sent raises nothing.
   */
  it('carries a capsule when a bug moved the impact record and no run exists', async () => {
    const { calls } = await cycle(
      {
        status: { knownRunIds: [], stateHashes: { impact: null } },
        sync: { capsules: { accepted: 1 } },
      },
      source({
        runs: () => [],
        derived: (kind) => ('impact' === kind ? { counts: { failed: 1 } } : undefined),
        capsules: () => [{ id: 'c1', summary: 'submit did nothing' }],
      }),
    );
    const post = calls.find((c) => 'POST' === c.method);
    expect((post?.body as { capsules: unknown[] }).capsules).toEqual([
      { id: 'c1', summary: 'submit did nothing' },
    ]);
  });

  it('sends a changed capsule set on its own, once, and not again while it is unchanged', async () => {
    const src = source({ capsules: () => [{ id: 'c1' }] });
    const first = await cycle(
      { status: { knownRunIds: [] }, sync: { capsules: { accepted: 1 } } },
      src,
    );
    expect(first.calls.some((c) => 'POST' === c.method)).toBe(true);
    const second = await cycle({ status: { knownRunIds: [] } }, src, first.written.state);
    expect(second.calls.some((c) => 'POST' === c.method)).toBe(false);
  });

  it('reports how many capsules the server accepted', async () => {
    const { report } = await cycle(
      { status: {}, sync: { runs: { accepted: 1 }, capsules: { accepted: 2 } } },
      source({
        runs: () => [{ runId: 'r', payload: { runId: 'r' } }],
        capsules: () => [{ id: 'c1' }, { id: 'c2' }],
      }),
    );
    expect(report.capsulesSent).toBe(2);
  });

  /*
   * The compatibility case, and the reason it is asserted rather than assumed.
   *
   * A server that predates this field answers without a `capsules` key. That must read as "none
   * accepted" and never as a failure: adding a field to the bundle cannot be allowed to break a sync
   * that was otherwise fine, or the next added field will be shipped by somebody who has learned to
   * be afraid of this one.
   */
  it('treats a server that says nothing about capsules as zero, not as an error', async () => {
    const { report } = await cycle(
      { status: {}, sync: { runs: { accepted: 1 } } },
      source({
        runs: () => [{ runId: 'r', payload: { runId: 'r' } }],
        capsules: () => [{ id: 'c1' }],
      }),
    );
    expect(report.ok).toBe(true);
    expect(report.capsulesSent).toBe(0);
  });

  it('carries the flows once something else IS moving', async () => {
    const { calls } = await cycle(
      { status: {}, sync: { runs: { accepted: 1 } } },
      source({
        runs: () => [{ runId: 'r', payload: { runId: 'r' } }],
        flows: () => [{ name: 'sign-in' }],
      }),
    );
    const post = calls.find((c) => 'POST' === c.method);
    expect((post?.body as { flows: unknown[] }).flows).toEqual([{ name: 'sign-in' }]);
  });
});

describe('decisions come back and are applied', () => {
  const pull = {
    triage: [
      {
        fingerprint: 'fp1',
        status: 'resolved',
        flowName: 'checkout',
        title: 'Flow "checkout": never settles',
        at: 5,
      },
    ],
    cursor: '5:fp1',
    more: false,
  };

  it('writes what a human decided, keyed by fingerprint', async () => {
    const { report, written } = await cycle({ status: {}, pull });
    expect(report.pulled).toBe(1);
    expect(written.issues?.triage['fp1']).toEqual({
      status: 'resolved',
      flowName: 'checkout',
      title: 'Flow "checkout": never settles',
      at: 5,
    });
  });

  it('keeps the flow name, which is the only id both sides already share', async () => {
    // A fingerprint is the server's join key and means nothing locally; the flow name is what lets
    // the HUD stop showing a defect somebody resolved.
    const { written } = await cycle({ status: {}, pull });
    expect(written.issues?.triage['fp1']?.flowName).toBe('checkout');
  });

  it('stores the cursor so the next cycle asks for less', async () => {
    const { written } = await cycle({ status: {}, pull });
    expect(written.state?.cursor).toBe('5:fp1');
  });

  it('sends the stored cursor back verbatim', async () => {
    const { calls } = await cycle({ status: {} }, source(), { cursor: '9:fpX' });
    expect(calls.find((c) => c.url.includes('/pull'))?.url).toContain(
      `since=${encodeURIComponent('9:fpX')}`,
    );
  });

  it('asks from the beginning when it has no cursor', async () => {
    const { calls } = await cycle({ status: {} });
    expect(calls.find((c) => c.url.includes('/pull'))?.url).not.toContain('since=');
  });

  it('writes no issues file at all when nothing was decided', async () => {
    const { written } = await cycle({ status: {} });
    expect(written.issues).toBeUndefined();
  });

  it('reports a full page so the caller can drain it now rather than in an hour', async () => {
    const { report } = await cycle({ status: {}, pull: { ...pull, more: true } });
    expect(report.morePending).toBe(true);
    expect(describeSync(report)).toContain('more waiting');
  });
});

describe('nothing local is harmed by a bad network', () => {
  it('reports a refused status door instead of throwing', async () => {
    const { report } = await cycle({ statusCode: 503 });
    expect(report.ok).toBe(false);
    expect(report.error).toContain('503');
    expect(describeSync(report)).toContain('sync failed');
  });

  it('survives a connection that never opens', async () => {
    const { report } = await cycle({ throwOn: '/v1/sync/status' });
    expect(report.ok).toBe(false);
    expect(report.error).toContain('ECONNREFUSED');
  });

  it('names the HOST that failed, not just that something did', async () => {
    // "fetch failed" on its own is indistinguishable from every other network problem, so the
    // person reading it in `reticle whoami` learns nothing and checks nothing.
    const { report } = await cycle({ throwOn: '/v1/sync/status' });
    expect(report.error).toContain('https://cloud.test');
  });

  it('unwraps the real reason Node hides in `cause`', async () => {
    const s = server({});
    const k = sink();
    const wrapped = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9999'), {
        code: 'ECONNREFUSED',
      }),
    });
    const report = await runSyncCycle({
      config: { url: 'https://cloud.test', apiKey: 'rk_test' },
      source: source(),
      sink: k.sink,
      state: {},
      now: () => NOW,
      request: () => Promise.reject(wrapped),
    });
    expect(report.error).toContain('fetch failed');
    expect(report.error, 'the reason, not just the symptom').toContain('ECONNREFUSED');
    expect(report.error).toContain('127.0.0.1:9999');
    expect(s.calls).toEqual([]);
  });

  it('never trails off into a dangling separator when the cause has no text', async () => {
    // A DNS failure carries a code and no message; a TLS failure the reverse. Both must read.
    const k = sink();
    const report = await runSyncCycle({
      config: { url: 'https://cloud.test', apiKey: 'rk_test' },
      source: source(),
      sink: k.sink,
      state: {},
      now: () => NOW,
      request: () =>
        Promise.reject(
          Object.assign(new TypeError('fetch failed'), {
            cause: Object.assign(new Error(''), { code: 'ENOTFOUND' }),
          }),
        ),
    });
    expect(report.error).toBe('fetch failed — ENOTFOUND (https://cloud.test)');
  });

  it('records WHY it is behind, so the next report can say more than “0 sent”', async () => {
    const { written } = await cycle({ statusCode: 401 });
    expect(written.state?.lastError).toContain('401');
  });

  it('clears the error once a cycle completes', async () => {
    const { written } = await cycle({ status: {} }, source(), { lastError: 'earlier failure' });
    expect(written.state?.lastError).toBeUndefined();
  });

  it('does not advance the cursor when the pull failed', async () => {
    const { written } = await cycle({ status: {}, pullCode: 500 }, source(), { cursor: 'keep-me' });
    expect(written.state?.cursor).toBe('keep-me');
  });

  it('still reports what the PUSH achieved when only the pull failed', async () => {
    const { report } = await cycle(
      { status: {}, sync: { runs: { accepted: 2 } }, pullCode: 500 },
      source({
        runs: () => [
          { runId: 'a', payload: {} },
          { runId: 'b', payload: {} },
        ],
      }),
    );
    expect(report.runsSent).toBe(2);
    expect(report.error).toContain('500');
  });

  it('surfaces a rejected artifact rather than leaving it silently stuck', async () => {
    const { report } = await cycle(
      {
        status: {},
        sync: { runs: { accepted: 1, rejected: [{ index: 1, reason: 'schema' }] } },
      },
      source({
        runs: () => [
          { runId: 'good', payload: {} },
          { runId: 'bad', payload: {} },
        ],
      }),
    );
    expect(report.runsRejected).toEqual([{ index: 1, reason: 'schema' }]);
    expect(describeSync(report)).toContain('1 rejected');
  });
});

describe('the request itself', () => {
  it('authenticates every call with the project key', async () => {
    const s = server({ status: {} });
    await runSyncCycle({
      config: { url: 'https://cloud.test', apiKey: 'rk_secret' },
      source: source(),
      sink: sink().sink,
      state: {},
      now: () => NOW,
      request: async (url, init) => {
        expect(init.headers['authorization']).toBe('Bearer rk_secret');
        return s.request(url, init);
      },
    });
  });

  it('stamps when each half last ran, for a human asking why the dashboard looks old', async () => {
    const { written } = await cycle(
      { status: {}, sync: { runs: { accepted: 1 } } },
      source({ runs: () => [{ runId: 'r', payload: {} }] }),
    );
    expect(written.state?.lastPushAt).toBe(NOW);
    expect(written.state?.lastPullAt).toBe(NOW);
  });
});

/*
 * A run can change after it was sent. A session's live drive run is rewritten after every verdict,
 * under the same id, so the server held the first few verdicts and never saw the rest: the send was
 * decided by id alone, and an id the server already had was never sent again, so every later
 * verdict in that tab stayed on the machine. The server upserts a run by id, so sending it again is the fix; the
 * machine remembers what it sent so it can tell a changed run from one it already delivered.
 */
describe('a run that changed after it was sent', () => {
  const run = (verdicts: number) => ({
    runId: 'drive-s1',
    payload: { runId: 'drive-s1', verdicts },
  });

  it('sends it again, because the server only has the old content', async () => {
    const { calls } = await cycle(
      { status: { knownRunIds: ['drive-s1'] }, sync: { runs: { accepted: 1, rejected: [] } } },
      source({ runs: () => [run(9)] }),
      { sentRunHashes: { 'drive-s1': hashPayload(run(5).payload) } },
    );
    const post = calls.find((c) => 'POST' === c.method);
    expect((post?.body as { runs: unknown[] }).runs).toEqual([run(9).payload]);
  });

  it('does not send it again when nothing about it changed', async () => {
    const { calls } = await cycle(
      { status: { knownRunIds: ['drive-s1'] } },
      source({ runs: () => [run(5)] }),
      { sentRunHashes: { 'drive-s1': hashPayload(run(5).payload) } },
    );
    expect(calls.some((c) => 'POST' === c.method)).toBe(false);
  });

  it('remembers the content it just delivered, so the next change is the one that counts', async () => {
    const { written } = await cycle(
      { status: { knownRunIds: [] }, sync: { runs: { accepted: 1, rejected: [] } } },
      source({ runs: () => [run(5)] }),
    );
    expect(written.state?.sentRunHashes).toEqual({ 'drive-s1': hashPayload(run(5).payload) });
  });

  /*
   * A machine upgraded onto this has never hashed anything, and some of what the server holds from
   * it may already be stale: a run sent before it gained its later verdicts. So a
   * run with no record is sent once, and recorded. Taking it as a baseline instead would leave exactly
   * that run wrong forever, since a closed tab never changes again. It costs one re-send of what
   * retention keeps, once; skipping costs the data.
   */
  it('sends once a run it has no record of, then remembers it', async () => {
    const { calls, written } = await cycle(
      { status: { knownRunIds: ['drive-s1'] }, sync: { runs: { accepted: 1, rejected: [] } } },
      source({ runs: () => [run(5)] }),
    );
    const post = calls.find((c) => 'POST' === c.method);
    expect((post?.body as { runs: unknown[] }).runs).toEqual([run(5).payload]);
    expect(written.state?.sentRunHashes).toEqual({ 'drive-s1': hashPayload(run(5).payload) });
  });

  it('keeps the old record when the changed run is refused, so it is tried again', async () => {
    const before = hashPayload(run(5).payload);
    const { written } = await cycle(
      {
        status: { knownRunIds: ['drive-s1'] },
        sync: { runs: { accepted: 0, rejected: [{ index: 0, reason: 'too large' }] } },
      },
      source({ runs: () => [run(9)] }),
      { sentRunHashes: { 'drive-s1': before } },
    );
    expect(written.state?.sentRunHashes).toEqual({ 'drive-s1': before });
  });

  it('forgets the record of a run that is no longer on disk', async () => {
    const { written } = await cycle(
      { status: { knownRunIds: ['drive-s1'] } },
      source({ runs: () => [run(5)] }),
      { sentRunHashes: { 'drive-s1': hashPayload(run(5).payload), gone: 'x' } },
    );
    expect(Object.keys(written.state?.sentRunHashes ?? {})).toEqual(['drive-s1']);
  });
});

/**
 * Everything the server refused is visible, not only runs.
 *
 * The push answer carries a rejection list per part and a status per derived record. The cycle read
 * only the runs, so a flow, a capsule or a record the platform threw away was reported as sent, the
 * cycle said ok, and the error was cleared: the dashboard missed it and nothing anywhere said so.
 */
describe('every refusal is reported, whichever part it was', () => {
  const OLD_KINDS = { impact: null, flake: null, intent: null };

  it('reports a refused flow, fails the cycle and keeps the reason as the last error', async () => {
    const { report, written } = await cycle(
      {
        status: { stateHashes: OLD_KINDS },
        sync: {
          runs: { accepted: 1, rejected: [] },
          flows: { accepted: 0, rejected: [{ index: 0, reason: 'steps must be an array' }] },
        },
      },
      source({
        runs: () => [{ runId: 'a', payload: { runId: 'a' } }],
        flows: () => [{ name: 'checkout', version: 2 }],
      }),
    );
    expect(report.ok).toBe(false);
    expect(describeSync(report)).toContain('checkout');
    expect(describeSync(report)).toContain('steps must be an array');
    expect(written.state?.lastError).toContain('steps must be an array');
  });

  it('reports a refused capsule', async () => {
    const { report } = await cycle(
      {
        status: { stateHashes: OLD_KINDS },
        sync: {
          runs: { accepted: 1, rejected: [] },
          capsules: { accepted: 0, rejected: [{ index: 0, reason: 'capsule too large' }] },
        },
      },
      source({
        runs: () => [{ runId: 'a', payload: { runId: 'a' } }],
        capsules: () => [{ id: 'c1' }],
      }),
    );
    expect(report.ok).toBe(false);
    expect(describeSync(report)).toContain('capsule too large');
  });

  it('counts a derived record as sent only when the server accepted it', async () => {
    const { report, written } = await cycle(
      {
        status: { stateHashes: OLD_KINDS },
        sync: { state: { impact: 'accepted', flake: 'flows must be an object' } },
      },
      source({
        derived: (kind) => ('impact' === kind || 'flake' === kind ? { v: kind } : undefined),
      }),
    );
    expect(report.derivedSent).toEqual(['impact']);
    expect(report.ok).toBe(false);
    expect(describeSync(report)).toContain('flows must be an object');
    expect(written.state?.lastError).toContain('flake');
  });

  it('keeps the last error when only runs were refused', async () => {
    const { report, written } = await cycle(
      {
        status: {},
        sync: { runs: { accepted: 0, rejected: [{ index: 0, reason: 'missing runId' }] } },
      },
      source({ runs: () => [{ runId: 'a', payload: {} }] }),
      { lastError: 'old' },
    );
    expect(report.ok).toBe(false);
    expect(written.state?.lastError).toContain('missing runId');
  });

  it('clears the last error once a cycle refuses nothing', async () => {
    const { report, written } = await cycle(
      { status: {}, sync: { runs: { accepted: 1, rejected: [] } } },
      source({ runs: () => [{ runId: 'a', payload: { runId: 'a' } }] }),
      { lastError: 'old' },
    );
    expect(report.ok).toBe(true);
    expect(written.state?.lastError).toBeUndefined();
  });
});

/**
 * A platform that does not know a record kind never returns a hash for it, so "hash differs" was
 * true forever: every cycle re-uploaded that record, dragged every flow and capsule along with it,
 * and the daemon, seeing something move, stayed on its fast interval.
 */
describe('a platform that predates a record kind', () => {
  const ENVELOPES = { version: 1, routes: {} };
  const withNewKinds = source({
    derived: (kind) =>
      'envelopes' === kind ? ENVELOPES : 'assertion-tiers' === kind ? { version: 1 } : undefined,
    flows: () => [{ name: 'sign-in', version: 2 }],
  });
  const OLD = { status: { stateHashes: { impact: null, flake: null, intent: null } } };

  it('sends nothing it does not list, cycle after cycle, and stays ok', async () => {
    // The flow set goes once (it changed from nothing); after that, only unlisted kinds remain, and
    // those are never sent.
    const first = await cycle({ ...OLD, sync: { flows: { accepted: 1 } } }, withNewKinds);
    const firstBody = first.calls.find((c) => 'POST' === c.method)?.body as Record<string, unknown>;
    expect(Object.keys(firstBody ?? {})).not.toContain('envelopes');
    expect(Object.keys(firstBody ?? {})).not.toContain('assertion-tiers');
    const second = await cycle(OLD, withNewKinds, first.written.state);
    const third = await cycle(OLD, withNewKinds, second.written.state);
    for (const run of [second, third]) {
      expect(run.calls.some((c) => 'POST' === c.method)).toBe(false);
      expect(run.report.ok).toBe(true);
    }
  });

  it('says once which kinds it held back', () => {
    return cycle(OLD, withNewKinds).then(({ report }) => {
      const line = describeSync(report);
      expect(line).toContain(
        'not sent: this platform does not accept envelopes, assertion-tiers yet',
      );
      expect(line.match(/not sent/g)).toHaveLength(1);
    });
  });

  it('prefers the explicit list of accepted kinds when the platform sends one', async () => {
    const { calls } = await cycle(
      {
        status: {
          stateHashes: { impact: null },
          accepts: { runVersions: [3], derived: ['impact', 'envelopes'] },
        },
        sync: { state: { envelopes: 'accepted' } },
      },
      withNewKinds,
    );
    const push = calls.find((c) => 'POST' === c.method)?.body as Record<string, unknown>;
    expect(Object.keys(push)).toContain('envelopes');
    expect(Object.keys(push)).not.toContain('assertion-tiers');
  });
});

/**
 * The platform says which file versions it reads. A flow or run in a version it does not read is
 * held back with a sentence that says what to do, rather than sent to be refused on every cycle.
 */
describe('artifacts in a version the platform does not read', () => {
  const FLOW_V3 = { name: 'checkout', version: 3 };
  const FLOW_V2 = { name: 'sign-in', version: 2 };
  const ACCEPTS = { flowVersions: [1, 2], runVersions: [1, 2, 3], derived: [] };

  it('holds back a flow in a version the platform does not read, and sends the rest', async () => {
    const { report, calls } = await cycle(
      { status: { accepts: ACCEPTS }, sync: { runs: { accepted: 1 }, flows: { accepted: 1 } } },
      source({
        runs: () => [{ runId: 'a', payload: { runId: 'a', schemaVersion: 3 } }],
        flows: () => [FLOW_V3, FLOW_V2],
      }),
    );
    const push = calls.find((c) => 'POST' === c.method)?.body as { flows: unknown[] };
    expect(push.flows).toEqual([FLOW_V2]);
    expect(describeSync(report)).toContain(
      'not sent: this platform reads flow versions 1, 2; checkout is version 3 — update the platform or remove `compare` from the flow',
    );
  });

  it('explains a flow refused for its version by a platform that did not say what it reads', async () => {
    const { report } = await cycle(
      {
        status: {},
        sync: {
          runs: { accepted: 1 },
          flows: {
            accepted: 0,
            rejected: [
              {
                index: 0,
                reason: 'flow version 3 is newer than this platform reads (1, 2)',
                code: FlowErrorCode.WRONG_VERSION,
                version: 3,
              },
            ],
          },
        },
      },
      source({
        runs: () => [{ runId: 'a', payload: { runId: 'a' } }],
        flows: () => [FLOW_V3],
      }),
    );
    expect(report.ok).toBe(false);
    expect(describeSync(report)).toContain(
      'checkout is version 3 — update the platform or remove `compare` from the flow',
    );
  });

  it('holds back a run in a version the platform does not read, and never marks it sent', async () => {
    const { report, calls, written } = await cycle(
      { status: { accepts: { ...ACCEPTS, runVersions: [1, 2] } }, sync: { runs: { accepted: 1 } } },
      source({
        runs: () => [
          { runId: 'new', payload: { runId: 'new', schemaVersion: 3 } },
          { runId: 'old', payload: { runId: 'old', schemaVersion: 2 } },
        ],
      }),
    );
    const push = calls.find((c) => 'POST' === c.method)?.body as { runs: unknown[] };
    expect(push.runs).toEqual([{ runId: 'old', schemaVersion: 2 }]);
    expect(written.state?.sentRunIds).toEqual(['old']);
    expect(describeSync(report)).toContain(
      'not sent: this platform reads run versions 1, 2; run new is version 3',
    );
  });
});

/**
 * One POST carried every unsent run. A backlog larger than the platform's body limit was refused
 * whole, the next cycle offered the same backlog, and it could never catch up.
 */
describe('a large backlog goes up in bounded batches', () => {
  const runs = (n: number, pad = 0) =>
    Array.from({ length: n }, (_, i) => ({
      runId: `r${String(i)}`,
      payload: { runId: `r${String(i)}`, pad: 'x'.repeat(pad) },
    }));

  it('splits by count and folds every batch into one report', async () => {
    const total = SYNC_BATCH_LIMITS.MAX_RUNS * 2 + 3;
    const { report, calls, written } = await cycle(
      { status: {}, sync: { runs: { accepted: SYNC_BATCH_LIMITS.MAX_RUNS, rejected: [] } } },
      source({ runs: () => runs(total) }),
    );
    const posts = calls.filter((c) => 'POST' === c.method);
    expect(posts.map((p) => (p.body as { runs: unknown[] }).runs.length)).toEqual([
      SYNC_BATCH_LIMITS.MAX_RUNS,
      SYNC_BATCH_LIMITS.MAX_RUNS,
      3,
    ]);
    expect(report.runsSent).toBe(SYNC_BATCH_LIMITS.MAX_RUNS * 3);
    expect(written.state?.sentRunIds).toHaveLength(total);
  });

  it('splits by size, so no batch passes the byte bound', async () => {
    const big = Math.floor(SYNC_BATCH_LIMITS.MAX_BYTES / 3);
    const { calls } = await cycle({ status: {} }, source({ runs: () => runs(5, big) }));
    const posts = calls.filter((c) => 'POST' === c.method);
    expect(posts.length).toBeGreaterThan(1);
    for (const p of posts)
      expect(JSON.stringify(p.body).length).toBeLessThanOrEqual(SYNC_BATCH_LIMITS.MAX_BYTES);
  });

  it('maps a rejection in a later batch back to the run it names', async () => {
    const total = SYNC_BATCH_LIMITS.MAX_RUNS + 2;
    const { report, written } = await cycle(
      {
        status: {},
        sync: { runs: { accepted: 1, rejected: [{ index: 0, reason: 'bad run' }] } },
      },
      source({ runs: () => runs(total) }),
    );
    // Index 0 of the second batch is the first run past the batch size.
    expect(report.runsRejected.map((r) => r.index)).toContain(SYNC_BATCH_LIMITS.MAX_RUNS);
    expect(written.state?.sentRunIds).not.toContain(`r${String(SYNC_BATCH_LIMITS.MAX_RUNS)}`);
  });
});

/**
 * A run the server rejected was offered again on every cycle, and the flows riding with it kept
 * the daemon on its fast interval, for an answer that could not change. It is now remembered with
 * the reason and what the platform said it reads, and retried only when either could change it.
 */
describe('a refused run is not re-offered until something could change the answer', () => {
  const REJECT = { runs: { accepted: 0, rejected: [{ index: 0, reason: 'unknown field "x"' }] } };
  const ACCEPTS = { runVersions: [1, 2, 3], flowVersions: [1, 2], derived: [] };
  const src = (payload: Record<string, unknown>) =>
    source({
      runs: () => [{ runId: 'bad', payload: { runId: 'bad', ...payload } }],
      flows: () => [{ name: 'sign-in', version: 2 }],
    });

  it('does not send it again, reports it, and sends it once the platform reads more', async () => {
    const first = await cycle({ status: { accepts: ACCEPTS }, sync: REJECT }, src({}));
    expect(first.calls.some((c) => 'POST' === c.method)).toBe(true);
    const state = first.written.state ?? {};

    const second = await cycle({ status: { accepts: ACCEPTS }, sync: REJECT }, src({}), state);
    expect(second.calls.some((c) => 'POST' === c.method)).toBe(false);
    expect(second.report.ok).toBe(false);
    expect(describeSync(second.report)).toContain(
      'refused, not retried: 1 run(s) (unknown field "x")',
    );
    expect(second.written.state?.lastError).toContain('refused, not retried');

    const upgraded = { ...ACCEPTS, runVersions: [1, 2, 3, 4] };
    const third = await cycle(
      { status: { accepts: upgraded }, sync: { runs: { accepted: 1 } } },
      src({}),
      second.written.state ?? {},
    );
    expect(third.calls.some((c) => 'POST' === c.method)).toBe(true);
    expect(third.report.ok).toBe(true);
    expect(third.written.state?.refusedRuns).toEqual({});
  });

  it('retries it when the run file itself changes', async () => {
    const first = await cycle({ status: { accepts: ACCEPTS }, sync: REJECT }, src({}));
    const again = await cycle(
      { status: { accepts: ACCEPTS }, sync: REJECT },
      src({ fixed: true }),
      first.written.state ?? {},
    );
    expect(again.calls.some((c) => 'POST' === c.method)).toBe(true);
  });
});
