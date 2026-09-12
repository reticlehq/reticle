/**
 * Lease tools: acquire stamps identity into the URL and returns a correlatable sessionId; release
 * frees the slot; both fail clearly when no pool is wired. A fake pool stands in for the real one.
 */

import { describe, expect, it } from 'vitest';
import {
  LeaseNotReadyReason,
  ReticleCommand,
  RETICLE_URL_PARAM,
  Verified,
  VerifiedReason,
} from '@reticlehq/core';
import {
  LEASE_TOOLS,
  acquireLeasedSession,
  appendReticleParams,
  cleanNavError,
  evaluateSeedPrecondition,
  hasOriginLock,
  scrubSeedFromError,
  waitForLeasedSession,
} from './lease-tools.js';
import { assertVerdict } from './assert/assert-verdict.js';
import {
  evaluatePredicate,
  type Predicate,
  type PredicateSession,
} from '@reticlehq/engine/question/predicate/predicate.js';
import type { Session } from '../../portal/session/session.js';
import { ReticleTool } from '@reticlehq/core';
import type { ToolDeps } from './tool-kit.js';
import type { BrowserPool, Lease } from '../../portal/pool/browser-pool.js';

function tool(name: string): (deps: ToolDeps, args: Record<string, unknown>) => Promise<unknown> {
  const def = LEASE_TOOLS.find((t) => t.name === name);
  if (def === undefined) throw new Error(`no lease tool ${name}`);
  // Called on its own def rather than detached. `handler` is declared method-style (see tool-kit.ts),
  // so lifting the reference out drops the receiver — harmless for these handlers today, and exactly
  // the kind of thing that stops being harmless without warning.
  return (deps, args) => def.handler(deps, args);
}

/** A pool stub that records acquire calls and tracks active count. */
function fakePool(): {
  pool: BrowserPool;
  acquired: { url: string; sessionId: string | undefined; seedStorage?: unknown }[];
  /** Every (registeredId, leaseId) pair the lease told the pool about. */
  aliased: [string, string][];
  released: string[];
} {
  const acquired: { url: string; sessionId: string | undefined; seedStorage?: unknown }[] = [];
  let active = 0;
  const released: string[] = [];
  const aliased: [string, string][] = [];
  const byOrigin = new Map<string, string>();
  const originOf = (url: string): string | undefined => {
    try {
      return new URL(url).origin;
    } catch {
      return undefined;
    }
  };
  const pool = {
    acquire(url: string, opts: { sessionId?: string; seedStorage?: unknown } = {}): Promise<Lease> {
      acquired.push({ url, sessionId: opts.sessionId, seedStorage: opts.seedStorage });
      active += 1;
      const sessionId = opts.sessionId ?? 'gen';
      const origin = originOf(url);
      if (origin !== undefined) byOrigin.set(origin, sessionId);
      return Promise.resolve({ sessionId, url, release: () => Promise.resolve() });
    },
    release(sessionId: string): Promise<void> {
      released.push(sessionId);
      active = Math.max(0, active - 1);
      for (const [origin, id] of byOrigin) {
        if (id === sessionId) byOrigin.delete(origin);
      }
      return Promise.resolve();
    },
    activeCount: () => active,
    queuedCount: () => 0,
    leasedSessionIds: () => [...byOrigin.values()],
    leaseTtlMs: () => 300_000,
    leaseIdOnOrigin: (origin: string) => byOrigin.get(origin),
    touch: () => undefined,
    alias: (registeredId: string, leaseId: string) => {
      aliased.push([registeredId, leaseId]);
    },
  } as unknown as BrowserPool;
  return { pool, acquired, aliased, released };
}

// A sessions stub where the leased tab is already "connected", so acquire's wait-for-ready resolves
// immediately (no real polling) in the happy path.
const baseDeps = { sessions: { get: () => ({ id: 'live' }) } } as unknown as ToolDeps;

describe('appendReticleParams', () => {
  it('adds the namespaced session (and project) params to a normal url', () => {
    const out = appendReticleParams('http://localhost:3000/dash', 'lease-1', 'acme');
    const u = new URL(out);
    expect(u.searchParams.get(RETICLE_URL_PARAM.SESSION)).toBe('lease-1');
    expect(u.searchParams.get(RETICLE_URL_PARAM.PROJECT)).toBe('acme');
    expect(u.pathname).toBe('/dash');
  });

  it('preserves existing query params', () => {
    const out = appendReticleParams('http://localhost:3000/?tab=2', 'lease-9');
    const u = new URL(out);
    expect(u.searchParams.get('tab')).toBe('2');
    expect(u.searchParams.get(RETICLE_URL_PARAM.SESSION)).toBe('lease-9');
    expect(u.searchParams.has(RETICLE_URL_PARAM.PROJECT)).toBe(false);
  });
});

describe('cleanNavError', () => {
  it('extracts the net:: code from a noisy Playwright goto error (ANSI + call log stripped)', () => {
    const raw = `page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:5999/?__reticle_session=lease-x\nCall log:\n\u001b[2m  - navigating\u001b[22m`;
    expect(cleanNavError(new Error(raw))).toBe('net::ERR_CONNECTION_REFUSED');
  });

  it('reports a timeout plainly', () => {
    expect(cleanNavError(new Error('page.goto: Timeout 30000ms exceeded.'))).toBe(
      'navigation timed out',
    );
  });

  it('falls back to a trimmed first line without the url tail', () => {
    expect(cleanNavError(new Error('page.goto: something odd at http://x/y?z'))).toBe(
      'something odd',
    );
  });
});

describe('reticle_lease_acquire failure surfaces a clean message', () => {
  it('a navigation failure becomes "could not open <url> — is the app running?"', async () => {
    const pool = {
      acquire: () =>
        Promise.reject(new Error('page.goto: net::ERR_CONNECTION_REFUSED at http://x/')),
      activeCount: () => 0,
      queuedCount: () => 0,
    } as unknown as BrowserPool;
    await expect(
      tool(ReticleTool.LEASE_ACQUIRE)({ ...baseDeps, pool }, { url: 'http://localhost:3000/' }),
    ).rejects.toThrow(
      /could not open http:\/\/localhost:3000\/ — is the app running there\? \(net::ERR_CONNECTION_REFUSED\)/,
    );
  });
});

describe('reticle_lease_acquire preflights the browser (#400)', () => {
  it('refuses at the first call with the install fix when Chromium is absent, without a round trip', async () => {
    const { pool, acquired } = fakePool();
    await expect(
      tool(ReticleTool.LEASE_ACQUIRE)(
        { ...baseDeps, pool, browserProbe: () => Promise.resolve({ exists: false }) },
        { url: 'http://localhost:3000/' },
      ),
      // Carries "Chromium is not installed" so error-recovery routes it to the NO_POOL fix rather
      // than the misleading "is the app running?" a launch failure inside acquire would have produced.
    ).rejects.toThrow(/Chromium is not installed/);
    // The point of a PREflight: the pool was never asked to open anything.
    expect(acquired).toHaveLength(0);
  });

  it('proceeds normally when the probe says Chromium is present', async () => {
    const { pool, acquired } = fakePool();
    const result = (await tool(ReticleTool.LEASE_ACQUIRE)(
      { ...baseDeps, pool, browserProbe: () => Promise.resolve({ exists: true }) },
      { url: 'http://localhost:3000/' },
    )) as { sessionId: string };
    expect(result.sessionId).toMatch(/^lease-/);
    expect(acquired).toHaveLength(1);
  });

  it('skips the preflight entirely when no probe is wired (unchanged default)', async () => {
    const { pool, acquired } = fakePool();
    await tool(ReticleTool.LEASE_ACQUIRE)({ ...baseDeps, pool }, { url: 'http://localhost:3000/' });
    expect(acquired).toHaveLength(1);
  });
});

describe('waitForLeasedSession', () => {
  it('resolves true as soon as the tab is connected (no waiting)', async () => {
    const sleeper = (): Promise<void> => Promise.reject(new Error('should not sleep'));
    await expect(waitForLeasedSession(() => true, sleeper)).resolves.toBe(true);
  });

  it('polls then resolves true once the tab connects', async () => {
    let calls = 0;
    const connected = (): boolean => ++calls >= 3; // connects on the 3rd check
    const noWait = (): Promise<void> => Promise.resolve();
    await expect(waitForLeasedSession(connected, noWait, 10, 0)).resolves.toBe(true);
  });

  it('resolves false after exhausting attempts (app has no SDK)', async () => {
    const noWait = (): Promise<void> => Promise.resolve();
    await expect(waitForLeasedSession(() => false, noWait, 5, 0)).resolves.toBe(false);
  });
});

describe('reticle_lease_acquire', () => {
  it('navigates to the app url with a stamped session and returns it ready', async () => {
    const { pool, acquired } = fakePool();
    const result = (await tool(ReticleTool.LEASE_ACQUIRE)(
      { ...baseDeps, pool },
      {
        url: 'http://localhost:3000/dashboard',
        projectId: 'acme',
      },
    )) as { sessionId: string; url: string; leased: number; ready: boolean };

    expect(result.sessionId).toMatch(/^lease-/);
    expect(result.url).toBe('http://localhost:3000/dashboard'); // clean url returned to the agent
    expect(result.ready).toBe(true); // the wait-for-connect resolved
    expect(result.leased).toBe(1);

    // The pool was navigated to the identity-stamped url, correlated to the returned sessionId.
    const navUrl = new URL(acquired[0]?.url ?? '');
    expect(navUrl.searchParams.get(RETICLE_URL_PARAM.SESSION)).toBe(result.sessionId);
    expect(navUrl.searchParams.get(RETICLE_URL_PARAM.PROJECT)).toBe('acme');
    expect(acquired[0]?.sessionId).toBe(result.sessionId);
  });

  it('reuses a live lease on the same origin rather than minting a second tab', async () => {
    // The reported case: acquire, the page needs a reload, acquire again. A second context
    // leaves both tabs connected and every later tool requires sessionId.
    const { pool, acquired } = fakePool();
    const first = (await tool(ReticleTool.LEASE_ACQUIRE)(
      { ...baseDeps, pool },
      { url: 'http://localhost:3000/dashboard' },
    )) as { sessionId: string; reused?: boolean };
    const second = (await tool(ReticleTool.LEASE_ACQUIRE)(
      { ...baseDeps, pool },
      { url: 'http://localhost:3000/settings' },
    )) as { sessionId: string; reused?: boolean; hint?: string; leased: number };

    expect(second.sessionId).toBe(first.sessionId);
    expect(second.reused).toBe(true);
    expect(second.leased).toBe(1);
    expect(second.hint).toMatch(/already hold a lease on this origin/);
    expect(second.hint).toContain(first.sessionId);
    expect(acquired).toHaveLength(1);
  });

  it('mints a second lease when the first is on a different origin', async () => {
    const { pool, acquired } = fakePool();
    const first = (await tool(ReticleTool.LEASE_ACQUIRE)(
      { ...baseDeps, pool },
      { url: 'http://localhost:3000/' },
    )) as { sessionId: string };
    const second = (await tool(ReticleTool.LEASE_ACQUIRE)(
      { ...baseDeps, pool },
      { url: 'http://localhost:3001/' },
    )) as { sessionId: string; reused?: boolean };

    expect(second.sessionId).not.toBe(first.sessionId);
    expect(second.reused).toBeUndefined();
    expect(acquired).toHaveLength(2);
    expect(pool.activeCount()).toBe(2);
  });

  it('releases a dead lease on this origin and mints a fresh one', async () => {
    const { pool, acquired } = fakePool();
    const first = (await tool(ReticleTool.LEASE_ACQUIRE)(
      { ...baseDeps, pool },
      { url: 'http://localhost:3000/' },
    )) as { sessionId: string };
    const sessions = {
      get: (id: string) => (id === first.sessionId ? undefined : { id }),
      // Genuinely dead: no session anywhere is driving that leased tab. `all` is present because
      // the real sessions registry always has it, and resolving the lease now consults it.
      all: () => [],
    };

    const second = (await tool(ReticleTool.LEASE_ACQUIRE)(
      { ...baseDeps, pool, sessions } as unknown as ToolDeps,
      { url: 'http://localhost:3000/' },
    )) as { sessionId: string; reused?: boolean };

    expect(second.sessionId).not.toBe(first.sessionId);
    expect(second.reused).toBeUndefined();
    expect(acquired).toHaveLength(2);
    expect(pool.activeCount()).toBe(1);
  });

  it('reuses a live lease whose app registered under its own name', async () => {
    // The asymmetry: the MINT path resolves the id through `resolveLeasedSessionId` — because "an
    // app that names its own session registers under that name, and the id we hand back has to be
    // the one the agent can actually drive" — and the reuse branch looked the lease id up directly
    // instead. The two paths disagreed about what a session id is.
    //
    // It bites when the first acquire returned `ready: false`: the mint path only aliases when its
    // wait resolved, so nothing records the app's own name. If the app connects a moment later,
    // `leaseIdOnOrigin` hands back the raw lease id, the direct lookup misses, and a LIVE lease is
    // released to mint a second context — the tab-poisoning this branch exists to prevent.
    const { pool, acquired } = fakePool();
    const first = (await tool(ReticleTool.LEASE_ACQUIRE)(
      { ...baseDeps, pool },
      { url: 'http://localhost:3000/' },
    )) as { sessionId: string };
    const appNamed = {
      id: 'my-app',
      url: `http://localhost:3000/?${RETICLE_URL_PARAM.SESSION}=${first.sessionId}`,
    };
    const sessions = {
      get: (id: string) => (id === appNamed.id ? appNamed : undefined),
      all: () => [appNamed],
    };

    const second = (await tool(ReticleTool.LEASE_ACQUIRE)(
      { ...baseDeps, pool, sessions } as unknown as ToolDeps,
      { url: 'http://localhost:3000/checkout' },
    )) as { sessionId: string; reused?: boolean; leased: number };

    // The id handed back is the one the agent can drive, as on the mint path.
    expect(second.sessionId).toBe(appNamed.id);
    expect(second.reused).toBe(true);
    // The live lease was kept: no second context, and the slot count did not move.
    expect(acquired).toHaveLength(1);
    expect(second.leased).toBe(1);
    expect(pool.activeCount()).toBe(1);
  });

  it('tells the pool the other name a reused lease answers to', async () => {
    // Half a fix without this. Every later touch and release arrives under the id just handed back;
    // the pool is keyed by the id it navigated with, so without the alias the touches miss, the
    // lease ages out despite continuous activity, and the reaper closes the context mid-flow.
    const { pool, acquired, aliased } = fakePool();
    const first = (await tool(ReticleTool.LEASE_ACQUIRE)(
      { ...baseDeps, pool },
      { url: 'http://localhost:3000/' },
    )) as { sessionId: string };
    const appNamed = {
      id: 'my-app',
      url: `http://localhost:3000/?${RETICLE_URL_PARAM.SESSION}=${first.sessionId}`,
    };
    const sessions = {
      get: (id: string) => (id === appNamed.id ? appNamed : undefined),
      all: () => [appNamed],
    };

    await tool(ReticleTool.LEASE_ACQUIRE)({ ...baseDeps, pool, sessions } as unknown as ToolDeps, {
      url: 'http://localhost:3000/',
    });

    expect(aliased).toContainEqual([appNamed.id, first.sessionId]);
    expect(acquired).toHaveLength(1);
  });

  /**
   * A sessions stub whose tab answers, or does not, when probed.
   *
   * `answers: 'error'` is the interesting one: a reply saying the command failed still PROVES the
   * SDK is alive, which is the whole question a liveness probe asks.
   */
  function sessionsThatAnswer(
    id: string,
    answers: 'ok' | 'error' | 'never',
  ): {
    deps: { get: (i: string) => unknown; all: () => { id: string; url?: string }[] };
    probes: string[];
  } {
    const probes: string[] = [];
    const session = {
      id,
      command: (name: string) => {
        probes.push(name);
        if ('never' === answers) return Promise.reject(new Error('command timed out after 1500ms'));
        return Promise.resolve({
          ok: 'ok' === answers,
          error: 'error' === answers ? 'nope' : undefined,
        });
      },
    };
    // Answers for ANY id on purpose: the mint path's readiness wait then resolves on its first
    // look, so a test about the mint path costs milliseconds instead of the full 10s wait.
    return {
      deps: { get: (i: string) => (i === id || 'any' === id ? session : undefined), all: () => [] },
      probes,
    };
  }

  it('probes a reused lease and reports a tab that has stopped answering', async () => {
    // `ready: true` used to mean "a row is in the sessions map", which is why a lease could come back
    // ready and then be rejected by snapshot, state and console. Presence is not liveness: the map
    // still holds a tab that is attached, streaming events, and answering nothing.
    const { pool, acquired } = fakePool();
    const first = (await tool(ReticleTool.LEASE_ACQUIRE)(
      { ...baseDeps, pool },
      { url: 'http://localhost:3000/' },
    )) as { sessionId: string };
    const { deps: sessions, probes } = sessionsThatAnswer(first.sessionId, 'never');

    const second = (await tool(ReticleTool.LEASE_ACQUIRE)(
      { ...baseDeps, pool, sessions } as unknown as ToolDeps,
      { url: 'http://localhost:3000/' },
    )) as { sessionId: string; ready: boolean; reused?: boolean; notReadyReason?: string };

    expect(probes).toEqual([ReticleCommand.CAPABILITIES]);
    expect(second.ready).toBe(false);
    expect(second.notReadyReason).toBe(LeaseNotReadyReason.SDK_STOPPED_ANSWERING);
    // Still the lease it found. A wedged tab is reported, not silently swapped for a second context.
    expect(second.sessionId).toBe(first.sessionId);
    expect(acquired).toHaveLength(1);
  });

  it('counts any reply as alive, including one that says the command failed', async () => {
    // The probe asks whether the SDK answers AT ALL, not what it says. An SDK too old to know the
    // command replies `unknown command '...'` — which is an answer, and so is proof.
    const { pool } = fakePool();
    const first = (await tool(ReticleTool.LEASE_ACQUIRE)(
      { ...baseDeps, pool },
      { url: 'http://localhost:3000/' },
    )) as { sessionId: string };
    const { deps: sessions } = sessionsThatAnswer(first.sessionId, 'error');

    const second = (await tool(ReticleTool.LEASE_ACQUIRE)(
      { ...baseDeps, pool, sessions } as unknown as ToolDeps,
      { url: 'http://localhost:3000/' },
    )) as { ready: boolean; reused?: boolean; notReadyReason?: string };

    expect(second.ready).toBe(true);
    expect(second.reused).toBe(true);
    expect(second.notReadyReason).toBeUndefined();
  });

  it('does not probe on the mint path, where the wait that just resolved is the evidence', async () => {
    // Cost control, and the reason it is free: on a mint the readiness wait resolved moments ago, so
    // a probe would re-ask a question just answered. On reuse the last evidence may be minutes old.
    const { pool } = fakePool();
    const { deps: sessions, probes } = sessionsThatAnswer('any', 'ok');

    await tool(ReticleTool.LEASE_ACQUIRE)({ ...baseDeps, pool, sessions } as unknown as ToolDeps, {
      url: 'http://localhost:3000/',
    });

    expect(probes).toEqual([]);
  });

  it('names the other reason when no SDK ever dialled in', async () => {
    // The two `ready: false` situations are opposite, and they used to share a bare `false`: check
    // the install, versus recover a tab that is wedged.
    const { pool } = fakePool();
    // `lastClosure` is present because the not-connected hint reads it on this branch — the stub is
    // matching the registry's real shape, not widening the code under test.
    const sessions = { get: () => undefined, all: () => [], lastClosure: () => undefined };

    const result = (await tool(ReticleTool.LEASE_ACQUIRE)(
      { ...baseDeps, pool, sessions } as unknown as ToolDeps,
      { url: 'http://localhost:3000/' },
    )) as { ready: boolean; notReadyReason?: string };

    expect(result.ready).toBe(false);
    expect(result.notReadyReason).toBe(LeaseNotReadyReason.SDK_NEVER_DIALLED);
    // A generous per-test budget, not a duration assertion: this is the ONLY case that pays the
    // real readiness wait, because proving "no SDK ever dialled in" means letting it run out.
  }, 20_000);

  it('treats a session it cannot probe as alive, rather than failing a working lease', async () => {
    // Fail OPEN. A registry entry with no `command` is a shape this code did not put there, and
    // turning a lease that works into a refusal over a probe that could not run would be a worse
    // failure than the one being fixed.
    const { pool, acquired } = fakePool();
    await tool(ReticleTool.LEASE_ACQUIRE)({ ...baseDeps, pool }, { url: 'http://localhost:3000/' });

    const second = (await tool(ReticleTool.LEASE_ACQUIRE)(
      { ...baseDeps, pool },
      { url: 'http://localhost:3000/' },
    )) as { ready: boolean; reused?: boolean; notReadyReason?: string };

    expect(second.ready).toBe(true);
    expect(second.reused).toBe(true);
    expect(second.notReadyReason).toBeUndefined();
    expect(acquired).toHaveLength(1);
  });

  it('returns expiresInMs so the agent knows when the lease will die', async () => {
    const { pool } = fakePool();
    const result = (await tool(ReticleTool.LEASE_ACQUIRE)(
      { ...baseDeps, pool },
      { url: 'http://localhost:3000/' },
    )) as { expiresInMs: number };
    expect(result.expiresInMs).toBe(300_000);
  });

  it('carries versionSkew on a ready lease whose tab is skewed (#688)', async () => {
    const SKEW = 'version skew: the page is 2.2.1; this daemon is 2.4.1. run reticle update';
    const { pool } = fakePool();
    const sessions = {
      get: () => ({ id: 'live', versionSkew: SKEW }),
      all: () => [],
    };
    const result = (await tool(ReticleTool.LEASE_ACQUIRE)(
      { sessions, pool } as unknown as ToolDeps,
      { url: 'http://localhost:3000/' },
    )) as { ready: boolean; versionSkew?: string };
    expect(result.ready).toBe(true);
    expect(result.versionSkew).toBe(SKEW);
  });

  it('throws a clear error when no pool is available', async () => {
    await expect(
      tool(ReticleTool.LEASE_ACQUIRE)(baseDeps, { url: 'http://localhost:3000/' }),
    ).rejects.toThrow(/pool unavailable/i);
  });

  it('requires a url', async () => {
    const { pool } = fakePool();
    await expect(tool(ReticleTool.LEASE_ACQUIRE)({ ...baseDeps, pool }, {})).rejects.toThrow(/url/);
  });
});

describe('reticle_lease_release', () => {
  it('releases by sessionId and reports the new leased count', async () => {
    const { pool } = fakePool();
    await tool(ReticleTool.LEASE_ACQUIRE)({ ...baseDeps, pool }, { url: 'http://localhost:3000/' });
    const acq = (await tool(ReticleTool.LEASE_ACQUIRE)(
      { ...baseDeps, pool },
      {
        url: 'http://localhost:3001/',
      },
    )) as { sessionId: string };
    expect(pool.activeCount()).toBe(2);

    const result = (await tool(ReticleTool.LEASE_RELEASE)(
      { ...baseDeps, pool },
      {
        sessionId: acq.sessionId,
      },
    )) as { released: boolean; leased: number };

    expect(result.released).toBe(true);
    expect(result.leased).toBe(1);
  });

  it('throws when no pool is available', async () => {
    await expect(
      tool(ReticleTool.LEASE_RELEASE)(baseDeps, { sessionId: 'lease-x' }),
    ).rejects.toThrow(/pool unavailable/i);
  });
});

describe('telling the human that the agent went somewhere invisible', () => {
  /**
   * Sessions stub with a watcher tab and a leased one, recording every narration posted.
   *
   * The selector is unit-tested next door; what is proved HERE is the wiring — that acquire and
   * release actually reach `pushNarration`. The reported bug was fifteen invisible tool calls, and a
   * correct selector nobody called would reproduce it exactly.
   */
  function depsWithWatcher(leasedIds: string[]): {
    deps: ToolDeps;
    narrations: { id: string; text: string }[];
  } {
    const narrations: { id: string; text: string }[] = [];
    const make = (id: string, projectId: string): unknown => ({
      id,
      projectId,
      pushNarration: (text: string) => narrations.push({ id, text }),
    });
    const watcher = make('s-human', 'acme');
    const leased = make('lease-1', 'acme');
    const { pool } = fakePool();
    const deps = {
      sessions: {
        all: () => [watcher, leased],
        get: (id: string) => ('s-human' === id ? watcher : leased),
      },
      pool: { ...pool, leasedSessionIds: () => leasedIds },
    } as unknown as ToolDeps;
    return { deps, narrations };
  }

  it("narrates into the human's tab on acquire, and not into the leased one", async () => {
    const { deps, narrations } = depsWithWatcher(['lease-1']);
    await tool(ReticleTool.LEASE_ACQUIRE)(deps, {
      url: 'http://localhost:3000/',
      projectId: 'acme',
    });
    expect(narrations.map((n) => n.id)).toEqual(['s-human']);
    expect(narrations[0]?.text).toContain('will not appear in this tab');
  });

  it('tells the tab it is live again once the LAST lease is released', async () => {
    const { deps, narrations } = depsWithWatcher(['lease-1']);
    await tool(ReticleTool.LEASE_RELEASE)(deps, { sessionId: 'lease-1' });
    expect(narrations.map((n) => n.text).join()).toContain('live again');
  });

  it('a narration that throws cannot fail the lease', async () => {
    // A courtesy to a person must never turn a working lease into a reported failure.
    const { pool } = fakePool();
    const deps = {
      sessions: {
        all: () => [{ id: 's-human', projectId: 'acme' }],
        get: () => ({
          id: 's-human',
          pushNarration: () => {
            throw new Error('socket gone');
          },
        }),
      },
      pool,
    } as unknown as ToolDeps;
    const out = (await tool(ReticleTool.LEASE_ACQUIRE)(deps, {
      url: 'http://localhost:3000/',
    })) as Record<string, unknown>;
    expect(out['sessionId']).toBeDefined();
  });
});

describe('prioritising a tab that is already open', () => {
  it('names the live non-leased tab so the agent can switch to the one a human can see', async () => {
    // Informing after the fact is not prioritising. The agent is told AT THE POINT OF CHOICE that a
    // visible tab already exists, because that is the only moment the choice is still open.
    const narrations: string[] = [];
    const watcher = {
      id: 's-human',
      projectId: 'acme',
      pushNarration: (t: string) => narrations.push(t),
    };
    const { pool } = fakePool();
    const deps = {
      sessions: { all: () => [watcher], get: () => watcher },
      pool,
    } as unknown as ToolDeps;

    const out = (await tool(ReticleTool.LEASE_ACQUIRE)(deps, {
      url: 'http://localhost:3000/',
      projectId: 'acme',
    })) as Record<string, unknown>;

    const prefer = out['preferExisting'] as { sessionId: string; note: string } | undefined;
    expect(prefer?.sessionId).toBe('s-human');
    expect(prefer?.note).toContain('release this lease');
  });

  it('stays silent when no tab was open — a lease is simply correct then', async () => {
    const { pool } = fakePool();
    const deps = {
      sessions: { all: () => [], get: () => ({ id: 'live' }) },
      pool,
    } as unknown as ToolDeps;

    const out = (await tool(ReticleTool.LEASE_ACQUIRE)(deps, {
      url: 'http://localhost:3000/',
      projectId: 'acme',
    })) as Record<string, unknown>;

    expect('preferExisting' in out).toBe(false);
  });

  it('never REFUSES the lease — isolation is a legitimate need', async () => {
    // The fix must not break agents that genuinely want a clean context. It steers; it does not veto.
    const watcher = { id: 's-human', projectId: 'acme', pushNarration: () => undefined };
    const { pool } = fakePool();
    const deps = {
      sessions: { all: () => [watcher], get: () => watcher },
      pool,
    } as unknown as ToolDeps;

    const out = (await tool(ReticleTool.LEASE_ACQUIRE)(deps, {
      url: 'http://localhost:3000/',
      projectId: 'acme',
    })) as Record<string, unknown>;

    expect(out['sessionId']).toBeDefined();
    expect(out['url']).toBe('http://localhost:3000/');
  });
});

describe('reticle_lease with seedStorage', () => {
  it('propagates seedStorage to pool.acquire and never echoes seeded values in the tool result', async () => {
    const { pool, acquired } = fakePool();
    const deps = { ...baseDeps, pool } as unknown as ToolDeps;
    const seedStorage = {
      local: { auth_token: 'secret-auth-token-12345' },
      session: { user_session: 'secret-session-abcde' },
      cookies: { session: 'secret-cookie-xyz99' },
    };

    const out = (await tool(ReticleTool.LEASE_ACQUIRE)(deps, {
      url: 'http://localhost:3000/app',
      seedStorage,
    })) as Record<string, unknown>;

    // seedStorage reached pool.acquire intact
    expect(acquired).toHaveLength(1);
    expect(acquired[0]?.seedStorage).toEqual(seedStorage);

    // Tool output must NEVER echo the seeded values or the seedStorage object
    expect('seedStorage' in out).toBe(false);
    expect(JSON.stringify(out)).not.toContain('secret-auth-token-12345');
    expect(JSON.stringify(out)).not.toContain('secret-session-abcde');
    expect(JSON.stringify(out)).not.toContain('secret-cookie-xyz99');
    expect(out['ready']).toBe(true);
    expect(out['sessionId']).toBeDefined();
  });

  it('rejects malformed seedStorage without echoing raw values in the error', async () => {
    const { pool } = fakePool();
    const deps = { ...baseDeps, pool } as unknown as ToolDeps;

    await expect(
      tool(ReticleTool.LEASE_ACQUIRE)(deps, {
        url: 'http://localhost:3000/',
        seedStorage: { local: 12345 as unknown as Record<string, string> },
      }),
    ).rejects.toThrow(/seedStorage is invalid: local: Expected object, received number/);
  });

  it('releases an existing lease on the origin and mints fresh when seedStorage is provided', async () => {
    const { pool, released } = fakePool();
    const deps = { ...baseDeps, pool } as unknown as ToolDeps;

    // First acquire without seedStorage
    const first = (await tool(ReticleTool.LEASE_ACQUIRE)(deps, {
      url: 'http://localhost:3000/',
    })) as Record<string, unknown>;
    const firstId = first['sessionId'] as string;

    // Second acquire with seedStorage on same origin must NOT reuse firstId; it must release firstId
    const second = (await tool(ReticleTool.LEASE_ACQUIRE)(deps, {
      url: 'http://localhost:3000/',
      seedStorage: { local: { token: 'new-token' } },
    })) as Record<string, unknown>;
    const secondId = second['sessionId'] as string;

    expect(secondId).not.toBe(firstId);
    expect(released).toContain(firstId);
    expect(second['reused']).toBeUndefined();
  });

  it('acquireLeasedSession propagates seedStorage to pool.acquire', async () => {
    const { pool, acquired } = fakePool();
    const sessions = { get: () => ({ id: 'live' }), all: () => [] };
    const seedStorage = { local: { token: 'auth-jwt' } };

    await acquireLeasedSession(
      pool,
      sessions,
      'http://localhost:3000/test',
      undefined,
      seedStorage,
    );

    expect(acquired).toHaveLength(1);
    expect(acquired[0]?.seedStorage).toEqual(seedStorage);
  });

  it('preserves explicit empty seedStorage ({}) semantics by releasing existing lease', async () => {
    const { pool, released } = fakePool();
    const deps = { ...baseDeps, pool } as unknown as ToolDeps;

    const first = (await tool(ReticleTool.LEASE_ACQUIRE)(deps, {
      url: 'http://localhost:3000/',
    })) as Record<string, unknown>;
    const firstId = first['sessionId'] as string;

    const second = (await tool(ReticleTool.LEASE_ACQUIRE)(deps, {
      url: 'http://localhost:3000/',
      seedStorage: {},
    })) as Record<string, unknown>;
    const secondId = second['sessionId'] as string;

    expect(secondId).not.toBe(firstId);
    expect(released).toContain(firstId);
  });

  it('re-throws sanitized Storage seeding failed error without masking as could not open', async () => {
    const { pool } = fakePool();
    pool.acquire = () =>
      Promise.reject(
        new Error('Storage seeding failed: localStorage write failed: QuotaExceededError'),
      );
    const deps = { ...baseDeps, pool } as unknown as ToolDeps;

    await expect(
      tool(ReticleTool.LEASE_ACQUIRE)(deps, {
        url: 'http://localhost:3000/',
        seedStorage: { local: { token: 'val' } },
      }),
    ).rejects.toThrow('Storage seeding failed: localStorage write failed: QuotaExceededError');
  });

  it('serializes concurrent seeded acquisitions on the same origin and cleans up lock', async () => {
    const { pool, acquired } = fakePool();
    const trace: string[] = [];
    const origin = 'http://localhost:3000';
    const originalAcquire = pool.acquire.bind(pool);
    pool.acquire = async (url, opts) => {
      const tag = url.includes('app1') ? 'req1' : 'req2';
      trace.push(`${tag}:acquire-start`);
      // Hold the lock for a moment to ensure concurrency contention
      await new Promise((r) => setTimeout(r, 20));
      const res = await originalAcquire(url, opts);
      trace.push(`${tag}:acquire-end`);
      return res;
    };
    const deps = { ...baseDeps, pool } as unknown as ToolDeps;

    expect(hasOriginLock(origin)).toBe(false);

    // Launch two concurrent seeded acquire calls for the same origin
    const p1 = tool(ReticleTool.LEASE_ACQUIRE)(deps, {
      url: `${origin}/app1`,
      seedStorage: { local: { k: '1' } },
    });
    const p2 = tool(ReticleTool.LEASE_ACQUIRE)(deps, {
      url: `${origin}/app2`,
      seedStorage: { local: { k: '2' } },
    });

    // While in flight, the origin lock must be held
    expect(hasOriginLock(origin)).toBe(true);

    const [res1, res2] = await Promise.all([p1, p2]);

    expect(acquired).toHaveLength(2);
    expect(res1).toBeDefined();
    expect(res2).toBeDefined();

    // Critical assertion: req1 must have finished acquiring before req2 began acquiring!
    expect(trace).toEqual([
      'req1:acquire-start',
      'req1:acquire-end',
      'req2:acquire-start',
      'req2:acquire-end',
    ]);

    // After completion, the origin lock must be completely cleaned up
    expect(hasOriginLock(origin)).toBe(false);
  });

  it('cleans up origin lock and allows subsequent acquires when an acquire fails', async () => {
    const { pool } = fakePool();
    const origin = 'http://localhost:3000';
    let failFirst = true;
    const originalAcquire = pool.acquire.bind(pool);
    pool.acquire = async (url, opts) => {
      if (failFirst) {
        failFirst = false;
        throw new Error('Storage seeding failed: test failure');
      }
      return originalAcquire(url, opts);
    };
    const deps = { ...baseDeps, pool } as unknown as ToolDeps;

    // First acquire fails
    await expect(
      tool(ReticleTool.LEASE_ACQUIRE)(deps, {
        url: `${origin}/app`,
        seedStorage: { local: { token: 'fail' } },
      }),
    ).rejects.toThrow('Storage seeding failed: test failure');

    // Lock must be cleaned up despite the failure
    expect(hasOriginLock(origin)).toBe(false);

    // Second acquire on the same origin succeeds without being blocked or deadlocked
    const second = (await tool(ReticleTool.LEASE_ACQUIRE)(deps, {
      url: `${origin}/app`,
      seedStorage: { local: { token: 'success' } },
    })) as Record<string, unknown>;

    expect(second['sessionId']).toBeDefined();
    expect(hasOriginLock(origin)).toBe(false);
  });

  describe('credential redaction & seed precondition semantics', () => {
    it('scrubSeedFromError redacts raw secret values and known secret patterns', () => {
      const jwt =
        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
      const customSecret = 'SUPER_SECRET_COOKIE_VAL_123';
      const seed = {
        cookies: { session: customSecret },
        local: { token: 'LOCAL_TOKEN_999' },
      };

      const errorMsg = `Error: failed to write cookie ${customSecret} with payload ${jwt} and local LOCAL_TOKEN_999`;
      const scrubbed = scrubSeedFromError(errorMsg, seed);

      expect(scrubbed).not.toContain(customSecret);
      expect(scrubbed).not.toContain(jwt);
      expect(scrubbed).not.toContain('LOCAL_TOKEN_999');
      expect(scrubbed).toContain('[REDACTED]');
    });

    it('reticle_lease acquire scrubs secret values when cookie injection fails', async () => {
      const secretToken = 'SECRET_TEST_TOKEN_AB12';
      const { pool } = fakePool();
      pool.acquire = () =>
        Promise.reject(
          new Error(
            `Storage seeding failed: cookie injection failed (invalid cookie: ${secretToken})`,
          ),
        );
      const deps = { ...baseDeps, pool } as unknown as ToolDeps;

      try {
        await tool(ReticleTool.LEASE_ACQUIRE)(deps, {
          url: 'http://localhost:3000/',
          seedStorage: { cookies: { auth: secretToken } },
        });
        expect.unreachable('should have thrown');
      } catch (err: unknown) {
        const msg = (err as Error).message;
        expect(msg).toContain('Storage seeding failed');
        expect(msg).not.toContain(secretToken);
        expect(msg).toContain('[REDACTED]');
      }
    });

    it('evaluateSeedPrecondition detects 401/403 status codes', () => {
      const failure401 = evaluateSeedPrecondition(
        'http://localhost:3000/dashboard',
        'http://localhost:3000/dashboard',
        { cookies: { token: 't' } },
        401,
      );
      expect(failure401).toContain('HTTP 401');

      const failure403 = evaluateSeedPrecondition(
        'http://localhost:3000/dashboard',
        'http://localhost:3000/dashboard',
        { cookies: { token: 't' } },
        403,
      );
      expect(failure403).toContain('HTTP 403');
    });

    it('evaluateSeedPrecondition detects cross-origin redirects when storage was seeded', () => {
      const failure = evaluateSeedPrecondition(
        'http://localhost:3000/app',
        'https://auth.external.com/login',
        { local: { key: 'val' } },
        200,
      );
      expect(failure).toContain('cross-origin redirect');
      expect(failure).toContain('skipped origin-scoped storage injection');
    });

    it('evaluateSeedPrecondition detects redirect to login endpoint when requested URL was not login', () => {
      const failure = evaluateSeedPrecondition(
        'http://localhost:3000/dashboard',
        'http://localhost:3000/login',
        { cookies: { auth: 'session' } },
        200,
      );
      expect(failure).toContain('redirected from /dashboard to login page (/login)');
    });

    it('evaluateSeedPrecondition accepts normal application redirects (e.g. / -> /dashboard)', () => {
      const ok = evaluateSeedPrecondition(
        'http://localhost:3000/',
        'http://localhost:3000/dashboard',
        { cookies: { auth: 'session' } },
        200,
      );
      expect(ok).toBeUndefined();
    });

    it('sets precondition failure on session and propagates to assertVerdict as UNKNOWN / INCONCLUSIVE', async () => {
      let preconditionFailure: string | undefined;
      const fakeSession = {
        id: 'lease-test-1',
        url: 'http://localhost:3000/login', // redirected to login!
        setPreconditionFailure: (reason: string) => {
          preconditionFailure = reason;
        },
        preconditionFailure: () => preconditionFailure,
        blindSpots: () => ({}),
        queryEvents: () => Promise.resolve([]),
        lostSince: () => false,
        lastAct: { cursor: () => 0, source: () => undefined },
        hasCapabilities: true,
        command: () =>
          Promise.resolve({ ok: true, result: { matched: false, count: 0, elements: [] } }),
        eventsSince: () => [],
        onEvent: () => () => {},
        elapsed: () => 100,
      };

      const { pool } = fakePool();
      const deps = {
        sessions: {
          get: () => fakeSession,
        },
        pool,
      } as unknown as ToolDeps;

      // Acquire with seedStorage requested for /dashboard
      const acquireResult = (await tool(ReticleTool.LEASE_ACQUIRE)(deps, {
        url: 'http://localhost:3000/dashboard',
        seedStorage: { cookies: { auth: 'cookie-val' } },
      })) as { sessionId: string };

      expect(acquireResult.sessionId).toBeDefined();
      expect(fakeSession.preconditionFailure()).toContain(
        'redirected from /dashboard to login page (/login)',
      );

      // Evaluate an assertion on this session that fails
      const predicate: Predicate = { kind: 'element', query: { text: 'Dashboard Welcome' } };
      const evalRes = await evaluatePredicate(
        fakeSession as unknown as PredicateSession,
        predicate,
      );
      expect(evalRes.pass).toBe(false);
      expect(evalRes.inconclusive).toContain('seeded authentication precondition not established');

      const verdict = await assertVerdict(
        fakeSession as unknown as Session,
        predicate,
        evalRes.pass,
        evalRes.evidence,
        0,
        evalRes.inconclusive,
      );

      expect(verdict.decision['verified']).toBe(Verified.UNKNOWN);
      expect(verdict.decision['verifiedReason']).toBe(VerifiedReason.INCONCLUSIVE);
      expect(verdict.decision['because']).toContain(
        'seeded authentication precondition not established',
      );
    });

    it('genuine workflow failure on authenticated session produces normal FAIL (NO / ASSERTION_FAILED)', async () => {
      const fakeSession = {
        id: 'lease-test-2',
        url: 'http://localhost:3000/dashboard', // stays on dashboard!
        setPreconditionFailure: () => {},
        preconditionFailure: () => undefined, // Precondition succeeded
        blindSpots: () => ({}),
        queryEvents: () => Promise.resolve([]),
        lostSince: () => false,
        lastAct: { cursor: () => 0, source: () => undefined },
        hasCapabilities: true,
        command: () =>
          Promise.resolve({ ok: true, result: { matched: false, count: 0, elements: [] } }),
        eventsSince: () => [],
        onEvent: () => () => {},
        elapsed: () => 100,
      };

      const predicate: Predicate = { kind: 'element', query: { text: 'Missing Button' } };
      const evalRes = await evaluatePredicate(
        fakeSession as unknown as PredicateSession,
        predicate,
      );
      expect(evalRes.pass).toBe(false);
      expect(evalRes.inconclusive).toBeUndefined();

      const verdict = await assertVerdict(
        fakeSession as unknown as Session,
        predicate,
        evalRes.pass,
        evalRes.evidence,
        0,
        evalRes.inconclusive,
      );

      expect(verdict.decision['verified']).toBe(Verified.NO);
      expect(verdict.decision['verifiedReason']).toBe(VerifiedReason.ASSERTION_FAILED);
      expect(verdict.decision['because']).toBe('the declared consequence did not hold');
    });
  });
});
