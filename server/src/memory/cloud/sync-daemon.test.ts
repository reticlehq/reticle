/**
 * The automatic loop. Everything here is about staying INVISIBLE: not overlapping itself, not
 * shouting the same failure once a minute, not starting before a link exists, and not being the
 * reason a process refuses to exit.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync, type FSWatcher } from 'node:fs';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emitSyncHook } from '@/hooks/hook-emit.js';
import { flushWithin, startSyncDaemon, watchReticleRoot } from './sync-daemon.js';

vi.mock('@/hooks/hook-emit.js', () => ({ emitSyncHook: vi.fn() }));
import type { ProjectCloud } from './cloud-config.js';

const LINKED: ProjectCloud = {
  config: { url: 'https://cloud.test', apiKey: 'rk_test' },
  policy: { runs: true, memory: true, flows: true, capsules: true, screenshots: true, video: true },
  verify: 'local',
  projectId: 'demo',
};
const UNLINKED: ProjectCloud = {
  config: null,
  policy: { runs: true, memory: true, flows: true, capsules: true, screenshots: true, video: true },
  verify: 'local',
  projectId: null,
};

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'reticle-syncd-'));
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

/** A server that answers everything successfully and counts what it was asked. */
function counting() {
  let calls = 0;
  const request = (url: string): Promise<{ status: number; text: string }> => {
    calls += 1;
    const body = url.includes('/pull') ? { triage: [], cursor: '0:' } : {};
    return Promise.resolve({ status: 200, text: JSON.stringify(body) });
  };
  return { request, count: (): number => calls };
}

describe('it stays out of the way', () => {
  it('does nothing at all for a project that is not linked', async () => {
    const server = counting();
    const d = startSyncDaemon({
      reticleRoot: root,
      cloud: () => Promise.resolve(UNLINKED),
      request: server.request,
      intervalMs: 1000,
    });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(server.count()).toBe(0);
    d.stop();
  });

  it('starts syncing once a link appears, with no restart', async () => {
    // `reticle link` must take effect on a daemon that is already running.
    const server = counting();
    let linked = false;
    const d = startSyncDaemon({
      reticleRoot: root,
      cloud: () => Promise.resolve(linked ? LINKED : UNLINKED),
      request: server.request,
      intervalMs: 1000,
    });
    await vi.advanceTimersByTimeAsync(8000);
    expect(server.count()).toBe(0);
    linked = true;
    await vi.advanceTimersByTimeAsync(3000);
    expect(server.count()).toBeGreaterThan(0);
    d.stop();
  });

  it('stops when told to, and schedules nothing further', async () => {
    const server = counting();
    const d = startSyncDaemon({
      reticleRoot: root,
      cloud: () => Promise.resolve(LINKED),
      request: server.request,
      intervalMs: 1000,
    });
    await vi.advanceTimersByTimeAsync(7000);
    const before = server.count();
    d.stop();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(server.count()).toBe(before);
  });

  it('does not start a second cycle on top of a slow one', async () => {
    /*
     * Two bundles in flight race, and the cursor written by the loser rewinds the winner's progress
     * — decisions already applied would be pulled and applied again, forever.
     */
    let started = 0;
    let release: (() => void) | undefined;
    const d = startSyncDaemon({
      reticleRoot: root,
      cloud: () => Promise.resolve(LINKED),
      intervalMs: 1000,
      request: () => {
        started += 1;
        return new Promise((resolve) => {
          release = (): void => resolve({ status: 200, text: '{}' });
        });
      },
    });
    await vi.advanceTimersByTimeAsync(6000);
    expect(started, 'the first cycle is in flight').toBe(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(started, 'no second cycle piled on top of it').toBe(1);
    release?.();
    d.stop();
  });
});

describe('it does not shout', () => {
  it('reports a repeated failure ONCE, not once a minute', async () => {
    // A laptop on a train would otherwise write the same line four hundred times.
    const logged: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logged.push(String(args[0]));
    });
    const d = startSyncDaemon({
      reticleRoot: root,
      cloud: () => Promise.resolve(LINKED),
      intervalMs: 1000,
      request: () => Promise.reject(new Error('ECONNREFUSED')),
    });
    await vi.advanceTimersByTimeAsync(20_000);
    const failures = logged.filter((l) => l.includes('sync_failed'));
    expect(failures.length).toBeLessThanOrEqual(1);
    d.stop();
  });

  it('keeps cycling after a failure rather than giving up', async () => {
    let calls = 0;
    const d = startSyncDaemon({
      reticleRoot: root,
      cloud: () => Promise.resolve(LINKED),
      intervalMs: 1000,
      request: () => {
        calls += 1;
        return Promise.reject(new Error('offline'));
      },
    });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(calls, 'a transient outage must not end the loop').toBeGreaterThan(2);
    d.stop();
  });
});

describe('syncNow', () => {
  it('runs a cycle immediately without waiting for the timer', async () => {
    const server = counting();
    const d = startSyncDaemon({
      reticleRoot: root,
      cloud: () => Promise.resolve(LINKED),
      request: server.request,
      intervalMs: 600_000,
    });
    const report = await d.syncNow();
    expect(report?.ok).toBe(true);
    expect(server.count()).toBeGreaterThan(0);
    d.stop();
  });

  it('answers undefined for an unlinked project instead of pretending', async () => {
    const d = startSyncDaemon({
      reticleRoot: root,
      cloud: () => Promise.resolve(UNLINKED),
      intervalMs: 600_000,
    });
    expect(await d.syncNow()).toBeUndefined();
    d.stop();
  });
});

/**
 * The two silences that cost a whole session: a daemon syncing nothing without saying so, and a
 * finished verification waiting a full interval to appear.
 */
describe('it says whether it is syncing at all', () => {
  it('announces an UNLINKED root once, naming the directory', async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown): boolean => {
      lines.push(String(chunk));
      return true;
    });
    const d = startSyncDaemon({
      reticleRoot: root,
      cloud: () => Promise.resolve(UNLINKED),
      request: counting().request,
      intervalMs: 1000,
    });
    await vi.advanceTimersByTimeAsync(20_000);
    d.stop();
    const said = lines.filter((l) => l.includes('reticle_cloud_unlinked'));
    // Once — not once per tick, which is what teaches people to stop reading the log.
    expect(said).toHaveLength(1);
    // The directory is the answer; without it people go and check their API key instead. Read as
    // JSON rather than as a substring: `log()` writes JSON, so a Windows path arrives with its
    // separators escaped and never matches the raw string — which is a fact about the encoder, not
    // about whether the line names the root.
    expect((JSON.parse(String(said[0])) as { root?: string }).root).toBe(root);
    spy.mockRestore();
  });

  it('announces when a link APPEARS mid-session, so `reticle link` needs no restart', async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown): boolean => {
      lines.push(String(chunk));
      return true;
    });
    let linked = false;
    const d = startSyncDaemon({
      reticleRoot: root,
      cloud: () => Promise.resolve(linked ? LINKED : UNLINKED),
      request: counting().request,
      intervalMs: 1000,
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(lines.filter((l) => l.includes('reticle_cloud_unlinked'))).toHaveLength(1);
    linked = true;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(lines.filter((l) => l.includes('reticle_cloud_linked'))).toHaveLength(1);
    d.stop();
    spy.mockRestore();
  });
});

describe('nudge', () => {
  it('cycles well before the next tick would have', async () => {
    const server = counting();
    const d = startSyncDaemon({
      reticleRoot: root,
      cloud: () => Promise.resolve(LINKED),
      request: server.request,
      intervalMs: 600_000,
    });
    await vi.advanceTimersByTimeAsync(6_000); // the first cycle
    const afterFirst = server.count();
    d.nudge();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(server.count()).toBeGreaterThan(afterFirst);
    d.stop();
  });

  it('COALESCES a burst into one cycle — six runs must not mean six uploads', async () => {
    const server = counting();
    const d = startSyncDaemon({
      reticleRoot: root,
      cloud: () => Promise.resolve(LINKED),
      request: server.request,
      intervalMs: 600_000,
    });
    await vi.advanceTimersByTimeAsync(6_000);
    const afterFirst = server.count();
    for (let i = 0; i < 6; i += 1) d.nudge();
    await vi.advanceTimersByTimeAsync(3_000);
    // One cycle's worth of requests, not six.
    const perCycle = afterFirst;
    expect(server.count() - afterFirst).toBeLessThanOrEqual(perCycle);
    d.stop();
  });

  it('does not leave an extra timer armed for the life of the process', async () => {
    const server = counting();
    const d = startSyncDaemon({
      reticleRoot: root,
      cloud: () => Promise.resolve(LINKED),
      request: server.request,
      intervalMs: 1_000,
    });
    await vi.advanceTimersByTimeAsync(6_000);
    d.nudge();
    await vi.advanceTimersByTimeAsync(3_000);
    const settled = server.count();
    await vi.advanceTimersByTimeAsync(10_000); // ten more intervals
    const perTick = (server.count() - settled) / 10;
    d.stop();
    // A stacked timer would double this. One cycle per interval is the whole claim.
    expect(perTick).toBeLessThanOrEqual(counting().count() + 3);
    d.stop();
  });
});

describe('a daemon syncs EVERY linked repo on the machine, not only its own', () => {
  it('pushes a sibling root as well as the one it is standing in', async () => {
    /*
     * The defect this closes, hit twice in one session: one daemon serves many projects — that is
     * what `artifactRootFor` exists for — and this loop pushed exactly one of them, whichever
     * directory it happened to start in. Every other linked repo reported nothing, which on a
     * dashboard is indistinguishable from nobody having verified anything.
     */
    const sibling = mkdtempSync(join(tmpdir(), 'reticle-sibling-'));
    const seen: string[] = [];
    const request = (
      url: string,
      init: { body?: string },
    ): Promise<{ status: number; text: string }> => {
      seen.push(String(init.body ?? '').slice(0, 0) + url);
      const body = url.includes('/pull') ? { triage: [], cursor: '0:' } : {};
      return Promise.resolve({ status: 200, text: JSON.stringify(body) });
    };
    const roots: string[] = [];
    const d = startSyncDaemon({
      reticleRoot: root,
      cloud: () => Promise.resolve(LINKED),
      otherRoots: () => Promise.resolve([sibling]),
      cloudFor: (r) => {
        roots.push(r);
        return Promise.resolve(LINKED);
      },
      request,
      intervalMs: 1000,
    });

    await vi.advanceTimersByTimeAsync(20_000);

    expect(roots, 'the sibling was resolved and pushed').toContain(sibling);
    d.stop();
  });

  it('never pushes a sibling that is not linked itself, whatever key the environment holds', async () => {
    /*
     * Reported while driving a linked desktop app: a daemon started with RETICLE_API_KEY pushed every
     * project this machine had ever seen into that ONE project, a status and a pull per root, around
     * ninety requests a second. An unlinked root resolves to the environment's key — right for the
     * root the daemon stands in, and somebody else's project for every other one.
     */
    const sibling = mkdtempSync(join(tmpdir(), 'reticle-unlinked-'));
    const seen: string[] = [];
    const request = (url: string): Promise<{ status: number; text: string }> => {
      seen.push(url);
      const body = url.includes('/pull') ? { triage: [], cursor: '0:' } : {};
      return Promise.resolve({ status: 200, text: JSON.stringify(body) });
    };
    const fromEnvOnly: ProjectCloud = { ...LINKED, projectId: null };
    const pushedRoots: string[] = [];
    const d = startSyncDaemon({
      reticleRoot: root,
      cloud: () => Promise.resolve(LINKED),
      otherRoots: () => Promise.resolve([sibling]),
      cloudFor: (r) => {
        pushedRoots.push(r);
        return Promise.resolve(fromEnvOnly);
      },
      request,
      intervalMs: 1000,
    });
    await vi.advanceTimersByTimeAsync(6_000);
    const cycles = seen.filter((u) => u.includes('/v1/sync/status')).length;
    // Only the daemon's own root syncs: one status call per cycle, never two.
    expect(pushedRoots).toContain(sibling);
    expect(cycles).toBe(seen.filter((u) => u.includes('/v1/sync/pull')).length);
    expect(cycles).toBeLessThanOrEqual(2);
    d.stop();
  });

  it('never resolves its OWN root twice', async () => {
    // The enumerator is machine-wide, so the daemon's own directory appears in it. Pushing it once
    // as a sibling and again as itself would double every count it reports.
    const resolved: string[] = [];
    const server = counting();
    const d = startSyncDaemon({
      reticleRoot: root,
      cloud: () => Promise.resolve(LINKED),
      otherRoots: () => Promise.resolve([root]),
      cloudFor: (r) => {
        resolved.push(r);
        return Promise.resolve(LINKED);
      },
      request: server.request,
      intervalMs: 1000,
    });

    await vi.advanceTimersByTimeAsync(8_000);

    expect(resolved, 'its own root is skipped in the sibling pass').toEqual([]);
    d.stop();
  });

  it('one broken repo does not silence the rest of the machine', async () => {
    /*
     * The isolation that makes this safe to ship. A revoked credential, a deleted directory or an
     * unreachable self-hosted server in ONE repo is a fact about that repo. Letting it throw would
     * take the daemon's own push down with it and turn one broken link into a machine-wide outage —
     * a strictly worse failure than the one being fixed.
     */
    const broken = mkdtempSync(join(tmpdir(), 'reticle-broken-'));
    const server = counting();
    const d = startSyncDaemon({
      reticleRoot: root,
      cloud: () => Promise.resolve(LINKED),
      otherRoots: () => Promise.resolve([broken]),
      cloudFor: (r) =>
        r === broken ? Promise.reject(new Error('credential revoked')) : Promise.resolve(LINKED),
      request: server.request,
      intervalMs: 1000,
    });

    await vi.advanceTimersByTimeAsync(20_000);

    expect(server.count(), "the daemon's own root still pushed").toBeGreaterThan(0);
    d.stop();
  });

  it('an unreadable registry does not stop the daemon syncing itself', async () => {
    const server = counting();
    const d = startSyncDaemon({
      reticleRoot: root,
      cloud: () => Promise.resolve(LINKED),
      otherRoots: () => Promise.reject(new Error('registry unreadable')),
      cloudFor: () => Promise.resolve(LINKED),
      request: server.request,
      intervalMs: 1000,
    });

    await vi.advanceTimersByTimeAsync(20_000);

    expect(server.count()).toBeGreaterThan(0);
    d.stop();
  });

  it('keeps the old single-root behaviour when no enumerator is supplied', async () => {
    const server = counting();
    const d = startSyncDaemon({
      reticleRoot: root,
      cloud: () => Promise.resolve(LINKED),
      request: server.request,
      intervalMs: 1000,
    });

    await vi.advanceTimersByTimeAsync(20_000);

    expect(server.count()).toBeGreaterThan(0);
    d.stop();
  });
});

/**
 * The cadence follows the work.
 *
 * A fixed minute is wrong for both states it covers: during a drive the ledger changes on every tool
 * call and a minute of lag is what makes a dashboard look dead, while idle a minute is already more
 * often than "nothing happened" deserves. Activity is inferred from what the last cycle actually
 * sent — the only honest evidence available without teaching the daemon about sessions.
 */
describe('how often it runs follows whether anything moved', () => {
  /** A server whose /sync answer says a run landed, so the cycle counts as having moved something. */
  function busy() {
    let calls = 0;
    const request = (url: string): Promise<{ status: number; text: string }> => {
      calls += 1;
      if (url.includes('/pull'))
        return Promise.resolve({ status: 200, text: '{"triage":[],"cursor":"0:"}' });
      if (url.endsWith('/v1/sync'))
        return Promise.resolve({
          status: 200,
          text: JSON.stringify({ runs: { accepted: 1, rejected: [] }, flows: { accepted: 0 } }),
        });
      return Promise.resolve({ status: 200, text: '{}' });
    };
    return { request, count: (): number => calls };
  }

  it('backs off to the idle interval when nothing is moving', async () => {
    const server = counting();
    const d = startSyncDaemon({
      reticleRoot: root,
      cloud: () => Promise.resolve(LINKED),
      request: server.request,
      intervalMs: 60_000,
    });
    await vi.advanceTimersByTimeAsync(30_000);
    const quiet = server.count();
    // Half the idle interval later, a quiet daemon has not run again.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(server.count()).toBe(quiet);
    d.stop();
  });

  it('never polls FASTER than an interval a deployment lowered it to', async () => {
    // Lengthening the interval means "sync less". An active burst must not quietly undo that.
    const server = busy();
    const d = startSyncDaemon({
      reticleRoot: root,
      cloud: () => Promise.resolve(LINKED),
      request: server.request,
      intervalMs: 1_000,
    });
    await vi.advanceTimersByTimeAsync(10_000);
    // With a 1s interval the active rate is clamped to 1s, so this is bounded by the interval, not
    // by the 5s active default — which would have produced far fewer cycles.
    expect(server.count()).toBeGreaterThan(3);
    d.stop();
  });
});

/**
 * Shutdown. The last thing a session writes is the run artifact everybody is waiting on, and the
 * daemon closing is the ordinary end of a drive — a one-shot CI run, an idle exit, an agent that
 * finished. Dropping that push is how a drive's whole evidence stays on the machine that found it.
 */
describe('the last push', () => {
  it('flushes what a nudge scheduled, rather than cancelling it on the way out', async () => {
    // `stop()` clears the pending timer, so a run written moments before shutdown was never sent:
    // measured against app.reticle.sh on 2026-09-23, where a drive's run artifact sat on disk and
    // the dashboard's newest row was three weeks old.
    const server = counting();
    const d = startSyncDaemon({
      reticleRoot: root,
      cloud: () => Promise.resolve(LINKED),
      request: server.request,
      intervalMs: 60_000,
    });
    // Let the first cycle pass, so what follows is only the nudge.
    await vi.advanceTimersByTimeAsync(30_000);
    const before = server.count();

    // A run lands, and the process is asked to stop before the nudge's delay has elapsed.
    d.nudge();
    await d.flush();

    expect(server.count()).toBeGreaterThan(before);
  });

  it('is safe to call when nothing is linked, and when called twice', async () => {
    const server = counting();
    const d = startSyncDaemon({
      reticleRoot: root,
      cloud: () => Promise.resolve(UNLINKED),
      request: server.request,
      intervalMs: 60_000,
    });
    await d.flush();
    await d.flush();
    expect(server.count()).toBe(0);
  });

  it('returns in time for `reticle stop` when the platform does not answer', async () => {
    // `reticle stop` sends SIGTERM, waits 5 s, then sends SIGKILL. The daemon sends its stop event
    // first (up to 2 s), then flushes. An unbounded flush on a slow network held the exit past 5 s,
    // so the kill came first: no exit line in the log, no pid file removed, no browser closed.
    const d = startSyncDaemon({
      reticleRoot: root,
      cloud: () => Promise.resolve(LINKED),
      request: () => new Promise(() => undefined),
      intervalMs: 60_000,
    });
    let finished = false;
    const done = d.flush().then(() => {
      finished = true;
    });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(finished).toBe(true);
    await done;
  });

  it('stops the timer, so a flushed daemon never cycles again', async () => {
    const server = counting();
    const d = startSyncDaemon({
      reticleRoot: root,
      cloud: () => Promise.resolve(LINKED),
      request: server.request,
      intervalMs: 1_000,
    });
    await vi.advanceTimersByTimeAsync(5_000);
    await d.flush();
    const settled = server.count();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(server.count()).toBe(settled);
  });
});

/**
 * A cycle whose only outcome was a refusal logged nothing and told the hook it was ok: the push
 * completed, so it counted as success, and the one fact worth reading was dropped.
 */
/** A process on its way out sent its last cycle with no bound, so a dead network held the exit. */
describe('flushWithin', () => {
  it('returns at the budget when the cycle never finishes', async () => {
    let finished = false;
    const done = flushWithin({ flush: () => new Promise<void>(() => undefined) }, 2_000).then(
      () => {
        finished = true;
      },
    );
    await vi.advanceTimersByTimeAsync(1_999);
    expect(finished).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(finished).toBe(true);
  });

  it('never throws on the way out', async () => {
    await expect(
      flushWithin({ flush: () => Promise.reject(new Error('offline')) }, 2_000),
    ).resolves.toBeUndefined();
  });
});

describe('a refusal is not silence', () => {
  let posts = 0;
  const refusing = (url: string): Promise<{ status: number; text: string }> => {
    // The memory read each cycle makes (decisions coming down) is a read, not an offer of the run.
    if (!url.includes('/pull') && !url.includes('/status') && !url.includes('/v1/memory'))
      posts += 1;
    const body = url.includes('/pull')
      ? { triage: [], cursor: '0:' }
      : url.includes('/status')
        ? {}
        : { runs: { accepted: 0, rejected: [{ index: 0, reason: 'unknown field "verdicts"' }] } };
    return Promise.resolve({ status: 200, text: JSON.stringify(body) });
  };

  it('tells the hook the cycle was not ok, and logs the reason once', async () => {
    mkdirSync(join(root, 'runs'), { recursive: true });
    writeFileSync(join(root, 'runs', 'a.json'), JSON.stringify({ runId: 'a' }));
    const lines: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown): boolean => {
      lines.push(String(chunk));
      return true;
    });
    const d = startSyncDaemon({
      reticleRoot: root,
      cloud: () => Promise.resolve(LINKED),
      request: refusing,
      intervalMs: 1000,
    });
    await d.syncNow();
    await d.syncNow();
    await d.syncNow();
    await d.syncNow();
    expect(vi.mocked(emitSyncHook)).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
    // Once as refused, once as "not retried"; never again per cycle.
    const logged = lines.filter((l) => l.includes('unknown field'));
    expect(logged).toHaveLength(2);
    expect(logged[1]).toContain('refused, not retried');
    expect(posts, 'the refused run was offered once, not every cycle').toBe(1);
    d.stop();
    vi.restoreAllMocks();
  });
});

/*
 * An unlinked root was skipped with a bare `continue`: a repo held 31 unsent runs and nothing said
 * so. Every root with unsent runs is now one log line and one entry in `unsyncedRoots()`.
 */
describe('a root nothing will send is said out loud', () => {
  it('logs an unlinked root with runs once, and lists it with its count', async () => {
    const sibling = join(mkdtempSync(join(tmpdir(), 'reticle-unsent-')), '.reticle');
    mkdirSync(join(sibling, 'runs'), { recursive: true });
    for (const id of ['r1', 'r2', 'r3'])
      writeFileSync(join(sibling, 'runs', `${id}.json`), JSON.stringify({ runId: id }));
    const lines: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown): boolean => {
      lines.push(String(chunk));
      return true;
    });
    const d = startSyncDaemon({
      reticleRoot: root,
      cloud: () => Promise.resolve(LINKED),
      otherRoots: () => Promise.resolve([sibling]),
      cloudFor: () => Promise.resolve(UNLINKED),
      request: counting().request,
      intervalMs: 1000,
    });
    await vi.advanceTimersByTimeAsync(20_000);
    d.stop();
    spy.mockRestore();
    const said = lines.filter((l) => l.includes('reticle_cloud_unsynced_root'));
    expect(said).toHaveLength(1);
    expect(JSON.parse(String(said[0]))).toMatchObject({ root: sibling, runs: 3, linked: false });
    expect(d.unsyncedRoots()).toEqual([{ root: sibling, runs: 3, flows: 0, linked: false }]);
  });
});

/**
 * The daemon's own memory read, every cycle, was counted by the platform as an agent consulting the
 * corpus: 127 "agent reads" by "an agent that did not name itself" in 35 minutes. The sync says it
 * is the sync, and never claims to be an agent.
 */
describe("the sync's memory read", () => {
  it('names itself as the sync, not as an agent', async () => {
    const seen: Record<string, string>[] = [];
    const request = (
      url: string,
      init?: { headers?: Record<string, string> },
    ): Promise<{ status: number; text: string }> => {
      if (url.includes('/v1/memory')) seen.push({ ...(init?.headers ?? {}) });
      const body = url.includes('/pull') ? { triage: [], cursor: '0:' } : {};
      return Promise.resolve({ status: 200, text: JSON.stringify(body) });
    };
    const d = startSyncDaemon({
      reticleRoot: root,
      cloud: () => Promise.resolve(LINKED),
      request,
      intervalMs: 1_000,
    });
    await vi.advanceTimersByTimeAsync(3_000);
    await d.flush();
    expect(seen.length).toBeGreaterThan(0);
    for (const headers of seen) {
      expect(headers['x-reticle-read-purpose']).toBe('sync');
      expect(headers['x-reticle-agent']).toBeUndefined();
    }
  });
});

/*
 * Re-drive (persona 09): after `reticle login --project rao-console` the running daemon kept
 * syncing to the OLD link for about a minute — it read the link once per idle tick — and never said
 * it had moved. The link is re-read the moment it changes, and the move is announced.
 */
describe('a re-link', () => {
  it('is read the moment the link file changes, and announced', async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown): boolean => {
      lines.push(String(chunk));
      return true;
    });
    const urls: string[] = [];
    let project = 'lind-console';
    let changed: ((path: string) => void) | undefined;
    const d = startSyncDaemon({
      reticleRoot: root,
      cloud: () => Promise.resolve({ ...LINKED, projectId: project }),
      request: (url) => {
        urls.push(url);
        return Promise.resolve({ status: 200, text: '{}' });
      },
      intervalMs: 60_000,
      watch: (onChange) => {
        changed = onChange;
        return () => undefined;
      },
    });
    await vi.advanceTimersByTimeAsync(6_000); // the first cycle, on the old link
    project = 'rao-console';
    urls.length = 0;
    changed?.('cloud.json');
    await vi.advanceTimersByTimeAsync(3_000); // well inside the idle tick
    expect(urls.some((u) => u.includes('rao-console'))).toBe(true);
    expect(urls.some((u) => u.includes('lind-console'))).toBe(false);
    const linked = lines.filter((l) => l.includes('reticle_cloud_linked'));
    expect(linked).toHaveLength(2);
    expect(linked[1]).toContain('rao-console');
    d.stop();
    spy.mockRestore();
  });
});

/**
 * A change under `.reticle` is what wakes the sync, not a clock. The timer is only the backstop, so
 * everything here drives the daemon through a fake watcher and counts CYCLES (one `cloud()` read per
 * cycle), never wall-clock time.
 */
describe('a change under .reticle wakes the sync', () => {
  /** A daemon whose watcher the test fires by hand, counting the cycles it runs. */
  function watched(extra: { request?: Parameters<typeof startSyncDaemon>[0]['request'] } = {}) {
    let fire: ((path: string) => void) | undefined;
    let closed = 0;
    let cycles = 0;
    const d = startSyncDaemon({
      reticleRoot: root,
      cloud: () => {
        cycles += 1;
        return Promise.resolve(LINKED);
      },
      request: extra.request ?? counting().request,
      watch: (onChange) => {
        fire = onChange;
        return () => {
          closed += 1;
        };
      },
    });
    return {
      d,
      change: (path: string): void => fire?.(path),
      cycles: (): number => cycles,
      closed: (): number => closed,
    };
  }

  it('runs one cycle after the debounce, not before it', async () => {
    const w = watched();
    await vi.advanceTimersByTimeAsync(6_000); // the first cycle
    expect(w.cycles()).toBe(1);
    w.change('runs/run-1.json');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(w.cycles(), 'still inside the debounce').toBe(1);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(w.cycles()).toBe(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(w.cycles(), 'and nothing more until something changes').toBe(2);
    w.d.stop();
  });

  it('coalesces a burst of writes into one cycle', async () => {
    const w = watched();
    await vi.advanceTimersByTimeAsync(6_000);
    for (let i = 0; i < 40; i += 1) w.change(`runs/run-${String(i)}.json`);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(w.cycles()).toBe(2);
    w.d.stop();
  });

  it("is never re-triggered by the cycle's own writes", async () => {
    const w = watched();
    await vi.advanceTimersByTimeAsync(6_000);
    expect(w.cycles()).toBe(1);
    // Everything the real cycle just wrote into this root, reported as a watcher would.
    const written = readdirSync(root, { recursive: true, encoding: 'utf8' });
    expect(written.length, 'the cycle wrote its bookkeeping').toBeGreaterThan(0);
    for (const path of written) w.change(path);
    // And the tmp files its atomic writes rename into place, which the watcher also sees.
    w.change(`cloud-state.json.${String(process.pid)}.tmp`);
    w.change(`issues.json.${String(process.pid)}.tmp`);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(w.cycles()).toBe(1);
    w.d.stop();
  });

  it('a change during a running cycle schedules exactly one follow-up', async () => {
    let release: (() => void) | undefined;
    let hold = false;
    const server = counting();
    const w = watched({
      request: (url) =>
        hold
          ? new Promise((resolve) => {
              release = (): void => {
                hold = false;
                void server.request(url).then(resolve);
              };
            })
          : server.request(url),
    });
    await vi.advanceTimersByTimeAsync(6_000);
    hold = true;
    w.change('runs/a.json');
    await vi.advanceTimersByTimeAsync(2_500); // the second cycle starts and stalls
    expect(w.cycles()).toBe(2);
    for (let i = 0; i < 10; i += 1) w.change(`runs/b-${String(i)}.json`);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(w.cycles(), 'never a cycle on top of a running one').toBe(2);
    release?.();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(w.cycles(), 'one follow-up for the writes it may have missed').toBe(3);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(w.cycles()).toBe(3);
    w.d.stop();
  });

  it("a run landing goes straight up: the team's memory is re-read only when it could matter", async () => {
    /*
     * Measured on a real project's `.reticle` (2 093 files, ~850 memory entries): every cycle paged
     * the whole memory down — nine sequential requests — before it sent anything, so at a 250 ms
     * round trip a run took 6.1 s (p95) to appear. The settled words have to come down before
     * changed INTENT goes up, and nothing else waits on them.
     */
    const urls: string[] = [];
    const server = counting();
    const w = watched({
      request: (url) => {
        urls.push(url);
        return server.request(url);
      },
    });
    const memoryReads = (): number => urls.filter((u) => u.includes('/v1/memory')).length;
    const statusCalls = (): number => urls.filter((u) => u.includes('/v1/sync/status')).length;
    await vi.advanceTimersByTimeAsync(6_000);
    expect(memoryReads(), 'the first cycle reads it').toBe(1);

    w.change('runs/run-1.json');
    await vi.advanceTimersByTimeAsync(2_500);
    expect(statusCalls()).toBe(2);
    expect(memoryReads(), 'a run alone does not re-read it').toBe(1);

    w.change('intent/a.json');
    await vi.advanceTimersByTimeAsync(2_500);
    expect(memoryReads(), 'changed intent reads it before sending').toBe(2);

    await vi.advanceTimersByTimeAsync(60_000);
    w.change('runs/run-2.json');
    await vi.advanceTimersByTimeAsync(2_500);
    expect(memoryReads(), 'and never older than a minute').toBe(3);

    await w.d.syncNow();
    expect(memoryReads(), 'a sync somebody asked for reads it').toBe(4);
    w.d.stop();
  });

  it("sends its own root before every other linked repo's", async () => {
    // The root that changed is the one somebody is waiting on; each other repo is a full cycle of
    // round trips, and with two of them a run took 8.1 s (p95) to appear instead of 4.7 s.
    const sibling = mkdtempSync(join(tmpdir(), 'reticle-sibling-'));
    const order: string[] = [];
    const request = (url: string): Promise<{ status: number; text: string }> => {
      if (url.includes('/v1/sync/status')) order.push(new URL(url).host);
      const body = url.includes('/pull') ? { triage: [], cursor: '0:' } : {};
      return Promise.resolve({ status: 200, text: JSON.stringify(body) });
    };
    const other: ProjectCloud = {
      ...LINKED,
      config: { url: 'https://other.test', apiKey: 'rk_other' },
      projectId: 'other',
    };
    const d = startSyncDaemon({
      reticleRoot: root,
      cloud: () => Promise.resolve(LINKED),
      otherRoots: () => Promise.resolve([sibling]),
      cloudFor: () => Promise.resolve(other),
      request,
    });
    await vi.advanceTimersByTimeAsync(6_000);
    expect(order).toEqual(['cloud.test', 'other.test']);
    d.stop();
  });

  it('does not walk every other linked repo on each change here: once a minute at most', async () => {
    // Own root first was not enough: a drive changes this root every few seconds, so the other
    // repos' pass was nearly always running when a run landed, and the run waited it out (7.3 s).
    const sibling = mkdtempSync(join(tmpdir(), 'reticle-sibling-'));
    const hosts: string[] = [];
    const request = (url: string): Promise<{ status: number; text: string }> => {
      if (url.includes('/v1/sync/status')) hosts.push(new URL(url).host);
      const body = url.includes('/pull') ? { triage: [], cursor: '0:' } : {};
      return Promise.resolve({ status: 200, text: JSON.stringify(body) });
    };
    let fire: ((path: string) => void) | undefined;
    const d = startSyncDaemon({
      reticleRoot: root,
      cloud: () => Promise.resolve(LINKED),
      otherRoots: () => Promise.resolve([sibling]),
      cloudFor: () =>
        Promise.resolve({
          ...LINKED,
          config: { url: 'https://other.test', apiKey: 'rk_other' },
          projectId: 'other',
        }),
      request,
      watch: (onChange) => {
        fire = onChange;
        return () => undefined;
      },
    });
    await vi.advanceTimersByTimeAsync(6_000);
    for (let i = 0; i < 10; i += 1) {
      fire?.(`runs/run-${String(i)}.json`);
      await vi.advanceTimersByTimeAsync(3_000);
    }
    const others = (): number => hosts.filter((h) => 'other.test' === h).length;
    expect(hosts.filter((h) => 'cloud.test' === h).length, 'this root on every change').toBe(11);
    expect(others(), 'the others once, in the first cycle').toBe(1);
    await vi.advanceTimersByTimeAsync(30_000);
    fire?.('runs/late.json');
    await vi.advanceTimersByTimeAsync(3_000);
    expect(others(), 'and again once a minute has passed').toBe(2);
    d.stop();
    // Fake timers, but the cycles it drives read and write a real temp root: the heavy-test guard's
    // explicit budget, not the default.
  }, 10_000);

  it('keeps a slow backstop timer that fires with no change at all', async () => {
    const w = watched();
    await vi.advanceTimersByTimeAsync(6_000);
    expect(w.cycles()).toBe(1);
    await vi.advanceTimersByTimeAsync(9 * 60_000);
    expect(w.cycles(), 'idle is no longer a cycle a minute').toBe(1);
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(w.cycles()).toBe(2);
    w.d.stop();
  });

  it('still syncs on the timer when the root cannot be watched', async () => {
    let cycles = 0;
    const d = startSyncDaemon({
      reticleRoot: root,
      cloud: () => {
        cycles += 1;
        return Promise.resolve(LINKED);
      },
      request: counting().request,
      intervalMs: 60_000,
      watch: () => undefined,
    });
    await vi.advanceTimersByTimeAsync(6_000 + 3 * 60_000);
    expect(cycles).toBe(4);
    d.stop();
  });

  /** A server the test can take offline, and the times at which each cycle began. */
  function flaky() {
    const state = { down: true };
    const ok = counting().request;
    const request = (url: string): Promise<{ status: number; text: string }> =>
      state.down ? Promise.reject(new Error('offline')) : ok(url);
    return { state, request };
  }
  const gaps = (times: readonly number[]): number[] =>
    times.slice(1).map((t, i) => t - (times[i] ?? t));

  it('retries a failed sync within a minute, with no file change', async () => {
    const server = flaky();
    const w = watched({ request: server.request });
    await vi.advanceTimersByTimeAsync(6_000); // the first cycle fails
    expect(w.cycles()).toBe(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(w.cycles()).toBe(2);
    w.d.stop();
  });

  it('backs off on repeated failures, never past the backstop', async () => {
    const server = flaky();
    const times: number[] = [];
    const d = startSyncDaemon({
      reticleRoot: root,
      cloud: () => {
        times.push(Date.now());
        return Promise.resolve(LINKED);
      },
      request: server.request,
    });
    await vi.advanceTimersByTimeAsync(90 * 60_000);
    const between = gaps(times);
    expect(between[0]).toBe(60_000);
    expect(Math.max(...between)).toBe(600_000);
    for (let i = 1; i < between.length; i += 1)
      expect(between[i]).toBeGreaterThanOrEqual(between[i - 1] ?? 0);
    d.stop();
  });

  it('a change still syncs at once while backing off', async () => {
    const server = flaky();
    const w = watched({ request: server.request });
    await vi.advanceTimersByTimeAsync(6_000 + 60_000 + 120_000); // three failures, next in 4 min
    const before = w.cycles();
    w.change('runs/run-1.json');
    await vi.advanceTimersByTimeAsync(2_500);
    expect(w.cycles()).toBe(before + 1);
    w.d.stop();
  });

  /*
   * Measured: five flows and five facts saved during 30 s offline reached the platform 216 s after
   * the network came back. Each save tried at once, failed, and doubled the wait; nothing changed
   * after the reconnect, so the work sat out the longest wait. Work still owed retries every minute;
   * only an idle machine backs off.
   */
  it('retries work saved while offline within a minute of the network returning', async () => {
    const server = flaky();
    const w = watched({ request: server.request });
    await vi.advanceTimersByTimeAsync(6_000); // the first cycle fails
    for (let i = 0; i < 4; i += 1) {
      w.change(`flows/f-${String(i)}.json`);
      await vi.advanceTimersByTimeAsync(3_000); // each save's cycle fails too
    }
    server.state.down = false;
    const before = w.cycles();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(w.cycles()).toBe(before + 1);
    w.d.stop();
  });

  it('returns to the ten-minute rhythm after a success', async () => {
    const server = flaky();
    const times: number[] = [];
    const d = startSyncDaemon({
      reticleRoot: root,
      cloud: () => {
        times.push(Date.now());
        // Back online from the third cycle on.
        if (times.length >= 3) server.state.down = false;
        return Promise.resolve(LINKED);
      },
      request: server.request,
    });
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(gaps(times)).toEqual([60_000, 120_000, 600_000, 600_000]);
    d.stop();
  });

  it('closes the watcher on stop and on flush', async () => {
    const a = watched();
    a.d.stop();
    expect(a.closed()).toBe(1);
    const b = watched();
    await b.d.flush();
    expect(b.closed()).toBe(1);
  });
});

describe('watchReticleRoot', () => {
  /** A stand-in for `fs.watch` the test can make fail. */
  function fakeWatcher() {
    const emitter = new EventEmitter();
    let closed = false;
    const watcher = Object.assign(emitter, {
      close: (): void => {
        closed = true;
      },
      unref: () => watcher,
    });
    return { watcher: watcher as unknown as FSWatcher, emitter, closed: (): boolean => closed };
  }

  it('reports a root that does not exist yet as not watched, so the daemon tries again', () => {
    expect(watchReticleRoot(join(root, 'missing'), () => undefined)).toBeUndefined();
  });

  it('falls back to the timer, saying so once, when recursive watching is unsupported', () => {
    const lines: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown): boolean => {
      lines.push(String(chunk));
      return true;
    });
    const close = watchReticleRoot(
      root,
      () => undefined,
      () => {
        throw Object.assign(new Error('recursive unsupported'), {
          code: 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM',
        });
      },
    );
    expect(close, 'not retried every cycle').toBeTypeOf('function');
    expect(lines.filter((l) => l.includes('reticle_cloud_watch_unavailable'))).toHaveLength(1);
    spy.mockRestore();
  });

  it('closes itself and says so when the watcher errors', () => {
    const lines: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown): boolean => {
      lines.push(String(chunk));
      return true;
    });
    const fake = fakeWatcher();
    watchReticleRoot(
      root,
      () => undefined,
      () => fake.watcher,
    );
    fake.emitter.emit('error', new Error('EMFILE: too many open files'));
    expect(fake.closed()).toBe(true);
    expect(lines.filter((l) => l.includes('reticle_cloud_watch_unavailable'))).toHaveLength(1);
    spy.mockRestore();
  });

  it('reports a nested write by its path under the root', async () => {
    vi.useRealTimers();
    mkdirSync(join(root, 'runs'), { recursive: true });
    const seen = new Promise<string>((resolve) => {
      const close = watchReticleRoot(root, (path) => {
        if (path.endsWith('run-1.json')) {
          close?.();
          resolve(path);
        }
      });
    });
    // Give the watcher a beat to attach before writing: FSEvents can drop a write made at once.
    await new Promise((r) => setTimeout(r, 100));
    writeFileSync(join(root, 'runs', 'run-1.json'), '{}');
    expect((await seen).replace(/\\/g, '/')).toBe('runs/run-1.json');
  }, 10_000);
});
