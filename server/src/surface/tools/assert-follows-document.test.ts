/**
 * An assertion that outlives the document it started on.
 *
 * A full-document navigation tears the in-page SDK down mid-wait. `waitForPredicate` sees the socket
 * close and finishes `observationLost`, which is honest — but `reticle_act_and_wait` then follows the
 * document that took over and re-asks there, and `reticle_assert` did not. Four field reports, one
 * shape: navigate, assert, `verified:"unknown" / observation_lost`; reconnect by hand, re-run the
 * UNCHANGED predicate, `verified:"yes"`. The answer was sitting on the successor the whole time.
 *
 * Both halves are guarded here. Following is only honest when there is exactly one candidate, so the
 * refusal to guess is as much the contract as the follow is.
 */
import { describe, expect, it } from 'vitest';
import { EventType, ReticleTool, type ReticleEvent } from '@reticlehq/core';
import { TOOLS, type ToolDeps } from './tools.js';
import type { SessionManager } from '@/portal/session/session-manager.js';
import type { Session } from '@/portal/session/session.js';
import { createFakeSession } from '@/portal/session/fake-session.js';

const SIGNAL_NAME = 'order:placed';
const DEPARTED_URL = 'http://app.test/checkout';
const SUCCESSOR_URL = 'http://app.test/thanks';
const TIMEOUT_MS = 2_000;

const signal = (): ReticleEvent => ({
  t: 1,
  type: EventType.SIGNAL,
  sessionId: 'next',
  data: { name: SIGNAL_NAME, data: {} },
});

/** The page that unloads mid-wait: it sees nothing, then its socket closes. */
function departedSession(): Session {
  return createFakeSession(
    {
      eventsSince: () => [],
      onDisconnect: (listener: () => void) => {
        const timer = setTimeout(listener, 5);
        return () => clearTimeout(timer);
      },
      health: () => ({ lastSeenMs: 0, throttled: false, focused: true }),
      bufferHealth: () => ({ total: 0, dropped: 0 }),
    },
    { sessionId: 'departed', url: DEPARTED_URL },
  );
}

/** The document that took over, where the declared consequence actually fired. */
function successorSession(id: string, url: string, saw: boolean): Session {
  return createFakeSession(
    {
      eventsSince: () => (saw ? [signal()] : []),
      health: () => ({ lastSeenMs: 0, throttled: false, focused: true }),
      bufferHealth: () => ({ total: 0, dropped: 0 }),
    },
    { sessionId: id, url },
  );
}

function depsOver(all: Session[], resolved: Session): ToolDeps {
  const sessions: Partial<SessionManager> = {
    resolve: () => resolved,
    get: (id: string) => all.find((s) => s.id === id),
    all: () => all,
  };
  return { sessions: sessions as SessionManager } as ToolDeps;
}

function assertTool() {
  const tool = TOOLS.find((t) => t.name === ReticleTool.ASSERT);
  if (tool === undefined) throw new Error('no reticle_assert tool');
  return tool;
}

const run = (deps: ToolDeps) =>
  assertTool().handler(deps, {
    predicate: { kind: 'signal', name: SIGNAL_NAME },
    timeout_ms: TIMEOUT_MS,
  }) as Promise<{ pass: boolean; observationLost?: boolean; sessionId?: string }>;

describe('reticle_assert across a full-document navigation', () => {
  it('re-asks on the document that took over instead of grading observation_lost', async () => {
    const departed = departedSession();
    const next = successorSession('next', SUCCESSOR_URL, true);
    const result = await run(depsOver([departed, next], departed));
    expect(result.observationLost).toBeUndefined();
    expect(result.pass).toBe(true);
  });

  it('names the session that answered, so the caller is not left holding a dead id', async () => {
    const departed = departedSession();
    const next = successorSession('next', SUCCESSOR_URL, true);
    const result = await run(depsOver([departed, next], departed));
    expect(result.sessionId).toBe('next');
  });

  it('still reports observation_lost when the consequence did not hold on the successor', async () => {
    const departed = departedSession();
    const next = successorSession('next', SUCCESSOR_URL, false);
    const result = await run(depsOver([departed, next], departed));
    expect(result.pass).toBe(false);
  });

  it('refuses to guess between two live tabs at the same origin', async () => {
    const departed = departedSession();
    const one = successorSession('one', SUCCESSOR_URL, true);
    const two = successorSession('two', 'http://app.test/other', true);
    const result = await run(depsOver([departed, one, two], departed));
    expect(result.observationLost).toBe(true);
    expect(result.sessionId).toBeUndefined();
  });

  it('leaves the session id off when the original document survived', async () => {
    const alive = successorSession('alive', DEPARTED_URL, true);
    const result = await run(depsOver([alive], alive));
    expect(result.pass).toBe(true);
    expect(result.sessionId).toBeUndefined();
  });
});
