/**
 * `reticle_navigate` with a URL and no session.
 *
 * Field defect: the first `navigate` of an agent with no connected app answered "no browser session
 * connected", and the agent stopped there. The call already named the app, so the daemon now opens
 * a lease on it. A relative URL names nothing to open, so it still refuses, and the refusal names
 * the absolute form. A daemon with sessions keeps the path it had.
 */
import { describe, expect, it } from 'vitest';
import { NO_SESSION_CONNECTED_ERROR, ReticleTool, SessionStartedVia } from '@reticlehq/core';
import { TOOLS, type ToolDeps } from './tools.js';
import { SessionManager } from '@/portal/session/session-manager.js';

const APP = 'http://localhost:3000/settings';

interface Fake {
  deps: ToolDeps;
  acquired: { url: string; owner?: string }[];
  commands: string[];
}

/** Sessions plus a pool. A lease the pool opens registers as a session at once. */
function fake(connected: { id: string; url: string }[], attachId = 'agent-1'): Fake {
  const acquired: Fake['acquired'] = [];
  const commands: string[] = [];
  const live = [...connected];
  const deps = {
    attachId,
    now: () => 0,
    recordings: { markNavigated: () => undefined },
    sessions: {
      all: () => live,
      list: () => live,
      count: () => live.length,
      get: (id: string) => live.find((s) => s.id === id),
      resolve: () => {
        if (0 === live.length) {
          throw new Error(NO_SESSION_CONNECTED_ERROR);
        }
        if (1 < live.length) {
          throw new Error('multiple sessions connected — pass sessionId');
        }
        return live[0];
      },
    },
    pool: {
      acquire: (url: string, o: { sessionId: string; owner?: string }) => {
        acquired.push({ url, ...(o.owner === undefined ? {} : { owner: o.owner }) });
        live.push({ id: o.sessionId, url });
        return Promise.resolve({ sessionId: o.sessionId, url, release: () => Promise.resolve() });
      },
      release: () => Promise.resolve(),
      activeCount: () => acquired.length,
      queuedCount: () => 0,
      leaseTtlMs: () => 300_000,
      leaseIdOnOrigin: () => undefined,
      leaseUrl: () => undefined,
      isHeaded: () => false,
      touch: () => undefined,
      alias: () => undefined,
    },
  } as unknown as ToolDeps;
  return { deps, acquired, commands };
}

function navigate(deps: ToolDeps, args: Record<string, unknown>): Promise<unknown> {
  const def = TOOLS.find((t) => ReticleTool.NAVIGATE === t.name);
  if (def === undefined) {
    throw new Error('no navigate tool');
  }
  return def.handler(deps, args);
}

describe('reticle_navigate with no session', () => {
  it('opens a lease on an absolute URL and says it started a session', async () => {
    const { deps, acquired } = fake([]);
    const result = (await navigate(deps, { url: APP })) as Record<string, unknown>;
    expect(acquired).toHaveLength(1);
    expect(acquired[0]?.url.startsWith(APP)).toBe(true);
    // Owned by the calling agent, the same as an explicit reticle_lease acquire.
    expect(acquired[0]?.owner).toBe('agent-1');
    const started = result['sessionStarted'] as { sessionId: string; via: string } | undefined;
    expect(started?.via).toBe(SessionStartedVia.LEASE);
    expect(started?.sessionId).toBe(result['sessionId']);
    expect(result['ok']).toBe(true);
    expect(result['confirmed']).toBe(true);
  });

  it('refuses a relative URL and names the absolute form', async () => {
    const { deps, acquired } = fake([]);
    await expect(navigate(deps, { url: '/settings' })).rejects.toThrow(
      /reticle_navigate .*http:\/\/localhost:\d+\/settings/,
    );
    expect(acquired).toHaveLength(0);
  });
});

describe('reticle_navigate with sessions', () => {
  it('drives the one connected session and opens no lease', async () => {
    const { deps, acquired, commands } = fake([{ id: 'tab-1', url: 'http://localhost:3000/' }]);
    const session = {
      id: 'tab-1',
      url: 'http://localhost:3000/',
      lastAct: { markNavigated: () => undefined },
      elapsed: () => 0,
      beginAction: () => undefined,
      finishAction: () => undefined,
      command: (name: string) => {
        commands.push(name);
        return Promise.resolve({ ok: true, result: { ok: false, reason: 'test double' } });
      },
    };
    (deps.sessions as unknown as { resolve: () => unknown }).resolve = () => session;
    const result = (await navigate(deps, { url: APP, timeout_ms: 0 })) as Record<string, unknown>;
    expect(acquired).toHaveLength(0);
    expect(commands).toHaveLength(1);
    expect(result['sessionStarted']).toBeUndefined();
  });

  it('keeps the ambiguity refusal and opens no lease', async () => {
    const { deps, acquired } = fake([
      { id: 'tab-1', url: 'http://localhost:3000/' },
      { id: 'tab-2', url: 'http://localhost:3000/' },
    ]);
    await expect(navigate(deps, { url: APP })).rejects.toThrow(/multiple sessions connected/);
    expect(acquired).toHaveLength(0);
  });
});

describe('the no-session refusal of every other tool', () => {
  it('names the navigate call that starts a session', () => {
    expect(() => new SessionManager().resolve()).toThrow(
      /call reticle_navigate with the absolute URL of the app/,
    );
  });
});
