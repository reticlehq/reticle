/**
 * `reticle_session { action: "end" }` must end the session it was given, or none.
 *
 * `resolve` answers a departed id with its live SUCCESSOR, which is right for everything that
 * observes: a tab reloads, its id survives in sessionStorage, and an `assert` keeps working. It is
 * wrong for a destructive call. Reported from the field twice: passing `sessionId: "sac14d46c…"`
 * returned `ended: true` for `"s08e37e5c…"`, once where the requested session's browser had just
 * closed — so the behaviour was "target missing ⇒ end something else" rather than "target missing
 * ⇒ say so". Ending another agent's session mid-verification is not recoverable (#983).
 */

import { describe, expect, it } from 'vitest';
import { PresenterTone, ReticleTool, SessionState } from '@reticlehq/core';
import { LIVE_CONTROL_TOOLS } from './live-control-tools.js';

const REQUESTED = 'sac14d46c';
const SUCCESSOR = 's08e37e5c';

function endTool() {
  const tool = LIVE_CONTROL_TOOLS.find((t) => t.name === ReticleTool.END_SESSION);
  if (tool === undefined) throw new Error('reticle_end_session is not defined');
  return tool;
}

/** A registry where `REQUESTED` has departed and `SUCCESSOR` is the live tab at the same origin. */
function depsWithSuccessor(): { deps: unknown; ended: string[] } {
  const ended: string[] = [];
  const successor = {
    id: SUCCESSOR,
    url: 'http://localhost:5173/app',
    setState: (state: SessionState) => {
      if (SessionState.ENDED === state) ended.push(SUCCESSOR);
    },
    // Ending a session reports what it proved, read from its journal.
    readJournalActions: () => Promise.resolve([]),
  };
  return {
    ended,
    deps: {
      sessions: {
        count: () => 1,
        get: (id: string) => (SUCCESSOR === id ? successor : undefined),
        departed: (id: string) => (REQUESTED === id ? { id, url: successor.url } : undefined),
        // What the real manager does for a departed id: hand back the successor.
        resolve: () => successor,
      },
    },
  };
}

describe('a named session is matched exactly, never substituted', () => {
  it('does not end a different session when the named one has departed', async () => {
    const { deps, ended } = depsWithSuccessor();

    await endTool().handler(deps as never, { sessionId: REQUESTED });

    expect(ended).toEqual([]);
  });

  it('answers idempotently, naming the session the caller asked about', async () => {
    const { deps } = depsWithSuccessor();

    const result = (await endTool().handler(deps as never, { sessionId: REQUESTED })) as Record<
      string,
      unknown
    >;

    // `ended: true` because the session IS ended — it disconnected. The id echoed back is the one
    // the caller named, so a reader can never mistake this for a report about another tab.
    expect(result['ended']).toBe(true);
    expect(result['sessionId']).toBe(REQUESTED);
    expect(String(result['note'])).toMatch(/already disconnected/i);
    expect(String(result['note'])).not.toContain(SUCCESSOR);
  });

  it('still ends a named session that is live', async () => {
    const { deps, ended } = depsWithSuccessor();

    const result = (await endTool().handler(deps as never, { sessionId: SUCCESSOR })) as Record<
      string,
      unknown
    >;

    expect(ended).toEqual([SUCCESSOR]);
    expect(result['sessionId']).toBe(SUCCESSOR);
    expect(result['note']).toBeUndefined();
  });

  it('refuses an id the daemon has never seen, rather than ending anything', () => {
    const ended: string[] = [];
    const deps = {
      sessions: {
        count: () => 1,
        get: () => undefined,
        departed: () => undefined,
        resolve: (id?: string) => {
          throw new Error(`no connected session with id '${String(id)}'`);
        },
      },
    };

    expect(() => endTool().handler(deps as never, { sessionId: 'never-existed' })).toThrow(
      /no connected session/i,
    );
    expect(ended).toEqual([]);
  });
});

/**
 * `reticle_session { action: "yield" }` with a named session must match it exactly, as `end` does.
 *
 * A yield on a departed id marked the live successor as waiting and answered with the successor's
 * id. The panel of a tab the agent never named then showed "waiting" (#1774).
 */
function yieldTool() {
  const tool = LIVE_CONTROL_TOOLS.find((t) => t.name === ReticleTool.YIELD);
  if (tool === undefined) throw new Error('reticle_session yield is not defined');
  return tool;
}

/** The registry of `depsWithSuccessor`, where the successor records each yield it receives. */
function yieldDepsWithSuccessor(): { deps: unknown; yielded: string[] } {
  const yielded: string[] = [];
  const successor = {
    id: SUCCESSOR,
    url: 'http://localhost:5173/app',
    autoEnd: () => {
      yielded.push(SUCCESSOR);
    },
  };
  return {
    yielded,
    deps: {
      sessions: {
        count: () => 1,
        get: (id: string) => (SUCCESSOR === id ? successor : undefined),
        departed: (id: string) => (REQUESTED === id ? { id, url: successor.url } : undefined),
        resolve: () => successor,
      },
    },
  };
}

describe('a named yield is matched exactly, never substituted', () => {
  it('does not yield a different session when the named one has departed', async () => {
    const { deps, yielded } = yieldDepsWithSuccessor();

    const result = (await yieldTool().handler(deps as never, {
      mode: PresenterTone.WAITING,
      sessionId: REQUESTED,
    })) as Record<string, unknown>;

    expect(yielded).toEqual([]);
    expect(result['yielded']).toBe(true);
    expect(result['sessionId']).toBe(REQUESTED);
    expect(String(result['note'])).toMatch(/already disconnected/i);
    expect(String(result['note'])).not.toContain(SUCCESSOR);
  });

  it('still yields a named session that is live', async () => {
    const { deps, yielded } = yieldDepsWithSuccessor();

    const result = (await yieldTool().handler(deps as never, {
      mode: PresenterTone.WAITING,
      sessionId: SUCCESSOR,
    })) as Record<string, unknown>;

    expect(yielded).toEqual([SUCCESSOR]);
    expect(result['sessionId']).toBe(SUCCESSOR);
    expect(result['note']).toBeUndefined();
  });
});

/**
 * `reticle_resume` and `reticle_review` with a named session must match it exactly, as `end` and
 * `yield` do.
 *
 * A resume on a departed id set the live successor to "active". That cleared a pause the human had
 * set by hand on a tab the agent never named. A review on a departed id listed the successor's
 * marks, and a `resolve` could retire one of them.
 */
function liveControlTool(name: string) {
  const tool = LIVE_CONTROL_TOOLS.find((t) => t.name === name);
  if (tool === undefined) throw new Error(`${name} is not defined`);
  return tool;
}

/** The registry of `depsWithSuccessor`, where the successor records each state set and each retired mark. */
function controlDepsWithSuccessor(): { deps: unknown; states: SessionState[]; retired: string[] } {
  const states: SessionState[] = [];
  const retired: string[] = [];
  const mark = { id: 'm1', note: 'the successor tab has a broken button' };
  const successor = {
    id: SUCCESSOR,
    url: 'http://localhost:5173/app',
    setState: (state: SessionState) => {
      states.push(state);
    },
    allMarks: () => [mark],
    pendingMarks: () => [mark],
    pendingMarkCount: () => 1,
    resolveMark: (id: string) => {
      retired.push(id);
      return true;
    },
    pushNarration: () => undefined,
  };
  return {
    states,
    retired,
    deps: {
      sessions: {
        count: () => 1,
        get: (id: string) => (SUCCESSOR === id ? successor : undefined),
        departed: (id: string) => (REQUESTED === id ? { id, url: successor.url } : undefined),
        resolve: () => successor,
      },
    },
  };
}

describe('a named resume is matched exactly, never substituted', () => {
  it('does not resume a different session when the named one has departed', async () => {
    const { deps, states } = controlDepsWithSuccessor();

    const result = (await liveControlTool(ReticleTool.RESUME).handler(deps as never, {
      sessionId: REQUESTED,
    })) as Record<string, unknown>;

    expect(states).toEqual([]);
    expect(result['ok']).toBe(true);
    expect(String(result['note'])).toMatch(/already disconnected/i);
    expect(String(result['note'])).not.toContain(SUCCESSOR);
  });

  it('still resumes a named session that is live', async () => {
    const { deps, states } = controlDepsWithSuccessor();

    const result = (await liveControlTool(ReticleTool.RESUME).handler(deps as never, {
      sessionId: SUCCESSOR,
    })) as Record<string, unknown>;

    expect(states).toEqual([SessionState.ACTIVE]);
    expect(result['note']).toBeUndefined();
  });
});

describe('a named review is matched exactly, never substituted', () => {
  it('refuses to list marks for a departed session instead of reading another tab', () => {
    const { deps } = controlDepsWithSuccessor();

    expect(() =>
      liveControlTool(ReticleTool.REVIEW).handler(deps as never, { sessionId: REQUESTED }),
    ).toThrow(/already disconnected/i);
  });

  it('does not retire a mark on a different session when the named one has departed', () => {
    const { deps, retired } = controlDepsWithSuccessor();

    expect(() =>
      liveControlTool(ReticleTool.REVIEW).handler(deps as never, {
        sessionId: REQUESTED,
        resolve: 'm1',
      }),
    ).toThrow(/already disconnected/i);
    expect(retired).toEqual([]);
  });

  it('names only the requested session in the refusal', () => {
    const { deps } = controlDepsWithSuccessor();

    expect(() =>
      liveControlTool(ReticleTool.REVIEW).handler(deps as never, { sessionId: REQUESTED }),
    ).toThrow(new RegExp(`^(?!.*${SUCCESSOR}).*${REQUESTED}`, 's'));
  });

  it('still lists the marks of a named session that is live', async () => {
    const { deps } = controlDepsWithSuccessor();

    const result = (await liveControlTool(ReticleTool.REVIEW).handler(deps as never, {
      sessionId: SUCCESSOR,
    })) as Record<string, unknown>;

    expect(result['pendingCount']).toBe(1);
  });
});
