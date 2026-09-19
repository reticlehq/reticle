/**
 * The replication protocol, driven against a scripted server.
 *
 * The properties worth locking are all about NOT COSTING ANYTHING and NOT LOSING ANYTHING: a quiet
 * machine must send nothing, a machine that has been offline must catch up without re-sending its
 * history, and no failure anywhere in the cycle may touch the local record — which is the only copy
 * that was ever authoritative.
 */
import { describe, expect, it } from 'vitest';
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
      text: JSON.stringify(script.sync ?? {}),
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
    const quiet = await cycle(
      { status: { knownRunIds: ['a'], stateHashes: { impact: hashPayload(IMPACT) } } },
      source({
        runs: () => [{ runId: 'a', payload: { runId: 'a' } }],
        derived: (kind) => ('impact' === kind ? IMPACT : undefined),
      }),
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
    );
    const post = calls.find((c) => 'POST' === c.method);
    expect((post?.body as { runs: Array<{ runId: string }> }).runs).toEqual([{ runId: 'new' }]);
    expect(report.runsSent).toBe(1);
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
      { status: { stateHashes: { impact: hashPayload(IMPACT) } } },
      source({ derived: (kind) => ('impact' === kind ? { ...IMPACT, changed: true } : undefined) }),
    );
    expect(report.derivedSent).toEqual(['impact']);
  });

  it('sends a record the server has never seen', async () => {
    const { report } = await cycle(
      { status: { stateHashes: { impact: null } } },
      source({ derived: (kind) => ('impact' === kind ? IMPACT : undefined) }),
    );
    expect(report.derivedSent).toEqual(['impact']);
  });

  it('does not pay a round trip for flows alone when nothing else moved', async () => {
    // Flows ride along; they are not worth waking the network for on their own.
    const { calls } = await cycle(
      { status: { knownRunIds: [] } },
      source({ flows: () => [{ name: 'sign-in' }] }),
    );
    expect(calls.some((c) => 'POST' === c.method)).toBe(false);
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

  it('does not pay a round trip for capsules alone when nothing else moved', async () => {
    const { calls } = await cycle(
      { status: { knownRunIds: [] } },
      source({ capsules: () => [{ id: 'c1' }] }),
    );
    expect(calls.some((c) => 'POST' === c.method)).toBe(false);
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
