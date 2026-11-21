/**
 * A check does not answer from the old page while a navigate has not arrived (#2300).
 *
 * `reticle_navigate` answered `confirmed: false`, and the tab still showed the old document while a
 * client-side route loaded. The next `reticle_assert` read the old page, and a text check passed on
 * text that only the old page showed. The pending state comes from the navigate result and the URL,
 * never from a request that is still open: a long-poll or a beacon is open on many correct apps.
 */
import { describe, expect, it } from 'vitest';
import { EventType, ReticleTool, type ReticleEvent } from '@reticlehq/core';
import { TOOLS, type ToolDef, type ToolDeps } from '@/surface/tools/tools.js';
import { BROWSER_TOOLS } from '@/surface/tools/browser-tools.js';
import { RecordingStore } from '@/language/flows/recording/tape/recordings.js';
import type { SessionManager } from '@/portal/session/session-manager.js';
import type { Session } from '@/portal/session/session.js';
import type { CommandResult } from '@reticlehq/core';
import { createFakeSession } from '@/portal/session/fake-session.js';
import { LastAct } from '@/portal/session/last-act.js';

const FROM = 'http://localhost:3000/';
const TO = 'http://localhost:3000/dashboard';
const SIGNAL = 'home:ready';

const signal = (): ReticleEvent => ({
  t: 1,
  type: EventType.SIGNAL,
  sessionId: 's',
  data: { name: SIGNAL, data: {} },
});

/** A tab on `url` whose buffer holds a signal that only the old page sent. */
function tabAt(url: string): Session {
  return createFakeSession(
    {
      eventsSince: () => [signal()],
      health: () => ({ lastSeenMs: 0, throttled: false, focused: true }),
      bufferHealth: () => ({ total: 1, dropped: 0 }),
    },
    { sessionId: 's', url },
  );
}

function depsOn(session: Session): ToolDeps {
  const sessions: Partial<SessionManager> = {
    resolve: () => session,
    get: () => session,
    all: () => [session],
    count: () => 1,
  };
  return { sessions: sessions as SessionManager, recordings: new RecordingStore() } as ToolDeps;
}

const tool = (name: string): ToolDef => {
  const found = TOOLS.find((t) => t.name === name);
  if (found === undefined) {
    throw new Error(`${name} is not on the surface`);
  }
  return found;
};

const ask = (session: Session) =>
  tool(ReticleTool.ASSERT).handler(depsOn(session), {
    predicate: { kind: 'signal', name: SIGNAL },
    since: 0,
  }) as Promise<{
    pass: boolean;
    verified?: string;
    inconclusive?: string;
    failureReason?: string;
  }>;

describe('reticle_assert while a navigate has not arrived', () => {
  it('answers unknown from the old page and names the pending target', async () => {
    const session = tabAt(FROM);
    session.lastAct.markNavigationPending(TO, (at) => at === TO);
    const result = await ask(session);
    expect(result.pass).toBe(false);
    expect(result.verified).toBe('unknown');
    expect(result.inconclusive).toContain(TO);
    expect(result.inconclusive).toContain('confirmed: false');
  });

  it('answers unknown in the wait form too', async () => {
    const session = tabAt(FROM);
    session.lastAct.markNavigationPending(TO, (at) => at === TO);
    const result = (await tool(ReticleTool.ASSERT).handler(depsOn(session), {
      action: 'wait',
      predicate: { kind: 'signal', name: SIGNAL },
      since: 0,
      timeout_ms: 0,
    })) as { pass: boolean; verified?: string; inconclusive?: string };
    expect(result.pass).toBe(false);
    expect(result.verified).toBe('unknown');
    expect(result.inconclusive).toContain(TO);
  });

  it('judges the page again once it reaches the target', async () => {
    const session = tabAt(TO);
    session.lastAct.markNavigationPending(TO, (at) => at === TO);
    const result = await ask(session);
    expect(result.pass).toBe(true);
    expect(result.inconclusive).toBeUndefined();
    expect(session.lastAct.pendingNavigationAt(FROM)).toBeUndefined();
  });

  it('judges the page as before when no navigate is pending', async () => {
    const result = await ask(tabAt(FROM));
    expect(result.pass).toBe(true);
  });
});

describe('what makes a navigation pending', () => {
  /** The navigate handler's own fakes: the browser accepts, and the target never arrives. */
  function navigateDeps(session: Session): ToolDeps {
    const sessions: Partial<SessionManager> = {
      resolve: () => session,
      count: () => 1,
      get: () => session,
      all: () => [],
    };
    return {
      sessions: sessions as SessionManager,
      now: () => 0,
      recordings: new RecordingStore(),
    } as unknown as ToolDeps;
  }

  function oldTab(): Session {
    const stub: Partial<Session> = {
      id: 's-old',
      url: FROM,
      elapsed: () => 0,
      lastAct: new LastAct(),
      beginAction: () => 'a1',
      finishAction: () => undefined,
      command: (): Promise<CommandResult> =>
        Promise.resolve({
          kind: 'command_result',
          id: 'c',
          ok: true,
          result: { ok: true, url: TO },
        }),
    };
    return stub as Session;
  }

  const nav = BROWSER_TOOLS.find((t) => t.name === ReticleTool.NAVIGATE);

  it('a navigate that answers confirmed: false marks its target pending', async () => {
    const session = oldTab();
    const out = await nav?.handler(navigateDeps(session), { url: TO, timeout_ms: 0 });
    expect(out).toMatchObject({ confirmed: false });
    expect(session.lastAct.pendingNavigationAt(FROM)).toBe(TO);
    expect(session.lastAct.pendingNavigationAt(TO)).toBeUndefined();
  });

  it('a later act or navigate clears it', () => {
    const lastAct = new LastAct();
    lastAct.markNavigationPending(TO, (at) => at === TO);
    lastAct.markActed(5, 'click', 1);
    expect(lastAct.pendingNavigationAt(FROM)).toBeUndefined();
    lastAct.markNavigationPending(TO, (at) => at === TO);
    lastAct.markNavigated(6);
    expect(lastAct.pendingNavigationAt(FROM)).toBeUndefined();
  });
});
