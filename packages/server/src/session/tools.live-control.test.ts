import { describe, expect, it } from 'vitest';
import { LastAct } from './last-act.js';
import { SessionState, Verified } from '@reticlehq/core';
import type { CommandResult } from '@reticlehq/core';
import { TOOLS, type ToolDeps } from '../tools/tools.js';
import { ReticleTool } from '../tools/tool-names.js';
import { BaselineStore } from '../project/baselines.js';
import { createNodeFileSystem } from '../project/fs-port.js';
import { RecordingStore } from '../flows/recordings.js';
import { FlowStore } from '../flows/flows.js';
import { ProjectStore } from '../project/project-store.js';
import { AnnotationStore } from '../flows/annotation-store.js';
import { PAUSE_HINT } from './control-envelope.js';
import type { InboxMessage, Session, SessionManager } from './session.js';

const SESSION_URL = 'http://localhost:5173/app';

interface SentCommand {
  name: string;
  args: Record<string, unknown>;
}
interface PushedPresenter {
  state: SessionState;
  text?: string;
  tone?: string;
}

/** Test-only probes attached to the fake Session. */
interface SessionProbes {
  __sent: SentCommand[];
  __pushed: PushedPresenter[];
}

type FakeSession = Session & SessionProbes;

/**
 * A fake Session with a mutable lifecycle state, an inbox, and recorders for `command` (the
 * wire path the action tools must NOT touch while paused) and `pushPresenter`.
 */
function fakeSession(opts: { state?: SessionState; inbox?: string[] }): FakeSession {
  let state = opts.state ?? SessionState.ACTIVE;
  const inbox: string[] = [...(opts.inbox ?? [])];
  const history: InboxMessage[] = [];
  const sent: SentCommand[] = [];
  const pushed: PushedPresenter[] = [];
  const stub: Partial<Session> = {
    id: 'demo',
    url: SESSION_URL,
    elapsed: () => 0,
    recordAction: () => 'a1',
    lastAct: new LastAct(),
    beginAction: () => 'a1',
    finishAction: () => undefined,
    bufferHealth: () => ({ total: 0, dropped: 0 }),
    lostSince: () => false,
    // Coverage is asked of the session now, not inferred from a window of events.
    blindSpots: () => ({}),
    // A failing verdict can now name the last acted control's file.
    eventsSince: () => [],
    queryEvents: () => Promise.resolve([]),
    onEvent: () => () => undefined,
    health: () => ({ lastSeenMs: 0, throttled: false, focused: true }),
    throttled: () => false,
    command: (name: string, args?: Record<string, unknown>): Promise<CommandResult> => {
      sent.push({ name, args: args ?? {} });
      return Promise.resolve({
        kind: 'command_result',
        id: 'c',
        ok: true,
        result: { dispatched: true, settled: true, count: 1, tree: 'root' },
      });
    },
    getState: () => state,
    setState: (next: SessionState, text?: string) => {
      // Mirror the real Session: setState echoes ONE PRESENTER push (optionally carrying text).
      state = next;
      pushed.push(text === undefined ? { state: next } : { state: next, text });
    },
    drainInbox: (): InboxMessage[] => {
      const taken = inbox.splice(0, inbox.length).map((text) => ({ text, t: 0 }));
      history.push(...taken);
      return taken;
    },
    // Delivery is destructive but must not be forgetful: an empty poll has to be able to say what
    // the human already said, or it reads as "they said nothing".
    inboxHistory: (): readonly InboxMessage[] => history,
    inboxSize: () => inbox.length,
    pushPresenter: (next: SessionState, text?: string) => {
      pushed.push(text === undefined ? { state: next } : { state: next, text });
    },
    autoEnd: (text?: string, tone?: string) => {
      // Mirror the real Session: a revivable end carrying the handoff tone (waiting/ask/warn).
      state = SessionState.ENDED;
      pushed.push({
        state: SessionState.ENDED,
        ...(text !== undefined ? { text } : {}),
        ...(tone !== undefined ? { tone } : {}),
      });
    },
  };
  return Object.assign(stub as Session, { __sent: sent, __pushed: pushed });
}

function fakeDeps(session: Session): ToolDeps {
  // `count` completes the fake rather than decorating it: this stub hands back a live session from
  // every `resolve`, so the honest count is 1. yield/end now ask, because they no-op when a turn
  // ends with nothing attached — see yield-without-session.test.ts for that half.
  const sessions: Partial<SessionManager> = { resolve: () => session, count: () => 1 };
  return {
    sessions: sessions as SessionManager,
    baselines: new BaselineStore(),
    recordings: new RecordingStore(),
    flows: new FlowStore(createNodeFileSystem(), '/tmp/reticle-test/.reticle', { now: () => 0 }),
    project: new ProjectStore(createNodeFileSystem(), '/tmp/reticle-test/.reticle', {
      now: () => 0,
    }),
    annotations: new AnnotationStore(),
    fs: createNodeFileSystem(),
    reticleRoot: '/tmp/reticle-test/.reticle',
    now: () => 0,
  };
}

function tool(name: string) {
  const t = TOOLS.find((x) => x.name === name);
  if (t === undefined) throw new Error(`no tool ${name}`);
  return t;
}

interface PausedShape {
  paused?: true;
  guidance?: string[];
  hint?: string;
}
interface ControlShape {
  control?: { state: SessionState; guidance: string[] };
  since?: number;
  effect?: unknown;
  verdict?: unknown;
  trace?: unknown;
  messages?: InboxMessage[];
}

const ACT_ARGS = { ref: 'e1', action: 'click' };

describe('live-control: pause short-circuit', () => {
  it('reticle_act executes normally when active and inbox empty', async () => {
    const session = fakeSession({ state: SessionState.ACTIVE, inbox: [] });
    const res = (await tool(ReticleTool.ACT).handler(fakeDeps(session), ACT_ARGS)) as ControlShape &
      PausedShape;
    expect(res.since).toBe(0);
    expect('result' in res).toBe(true);
    expect('control' in res).toBe(false);
    expect('paused' in res).toBe(false);
    expect(session.__sent.filter((c) => 'act' === c.name)).toHaveLength(1);
  });

  it('reticle_act short-circuits when paused — no ACT dispatched', async () => {
    const session = fakeSession({ state: SessionState.PAUSED, inbox: ['fix the form'] });
    const res = (await tool(ReticleTool.ACT).handler(fakeDeps(session), ACT_ARGS)) as PausedShape &
      ControlShape;
    expect(res.paused).toBe(true);
    expect(res.guidance).toEqual(['fix the form']);
    expect(res.hint).toBe(PAUSE_HINT);
    expect(res.since).toBeUndefined();
    expect(session.__sent).toHaveLength(0);
  });

  it('paused short-circuit drains the inbox once', async () => {
    const session = fakeSession({ state: SessionState.PAUSED, inbox: ['a', 'b'] });
    const first = (await tool(ReticleTool.ACT).handler(fakeDeps(session), ACT_ARGS)) as PausedShape;
    expect(first.guidance).toHaveLength(2);
    const second = (await tool(ReticleTool.ACT).handler(
      fakeDeps(session),
      ACT_ARGS,
    )) as PausedShape;
    expect(second.paused).toBe(true);
    expect(second.guidance).toHaveLength(0);
    expect(session.__sent).toHaveLength(0);
  });

  it('reticle_act_and_wait short-circuits when paused', async () => {
    const session = fakeSession({ state: SessionState.PAUSED, inbox: ['stop'] });
    const res = (await tool(ReticleTool.ACT_AND_WAIT).handler(fakeDeps(session), {
      ...ACT_ARGS,
      until: { kind: 'console', level: 'error', absent: true },
    })) as PausedShape;
    expect(res.paused).toBe(true);
    expect(res.guidance).toEqual(['stop']);
    expect(res.hint).toBe(PAUSE_HINT);
    expect(session.__sent).toHaveLength(0);
  });

  /**
   * A verification tool must always answer the one field its verdict hangs on. The pause
   * short-circuit returned a plain `{ paused, guidance, hint }`, so `verified` was ABSENT — not
   * yes/no/unknown — and an agent reading `result.verified` got undefined from a call that looked
   * like it had succeeded. Reported from the field on two apps.
   */
  it('reticle_act_and_wait says verified:unknown while paused, never nothing at all', async () => {
    const session = fakeSession({ state: SessionState.PAUSED, inbox: [] });
    const res = (await tool(ReticleTool.ACT_AND_WAIT).handler(fakeDeps(session), {
      ...ACT_ARGS,
      until: { kind: 'console', level: 'error', absent: true },
    })) as PausedShape & { verified?: string; because?: string };
    expect(res.verified).toBe(Verified.UNKNOWN);
    expect(res.because).toBeTruthy();
  });

  it('reticle_act_sequence short-circuits when paused', async () => {
    const session = fakeSession({ state: SessionState.PAUSED, inbox: ['stop'] });
    const res = (await tool(ReticleTool.ACT_SEQUENCE).handler(fakeDeps(session), {
      steps: [{ ref: 'e1', action: 'click' }],
    })) as PausedShape;
    expect(res.paused).toBe(true);
    expect(res.guidance).toEqual(['stop']);
    expect(session.__sent).toHaveLength(0);
  });
});

describe('live-control: piggyback', () => {
  it('active act with a pending message piggybacks control.guidance', async () => {
    const session = fakeSession({ state: SessionState.ACTIVE, inbox: ['look here'] });
    const res = (await tool(ReticleTool.ACT).handler(fakeDeps(session), ACT_ARGS)) as ControlShape;
    expect(res.since).toBe(0);
    expect('result' in res).toBe(true);
    expect(res.control).toEqual({
      state: SessionState.ACTIVE,
      guidance: ['look here'],
    });
    expect(session.__sent.filter((c) => 'act' === c.name)).toHaveLength(1);
  });

  it('piggyback guidance is delivered once', async () => {
    const session = fakeSession({ state: SessionState.ACTIVE, inbox: ['once'] });
    const first = (await tool(ReticleTool.ACT).handler(
      fakeDeps(session),
      ACT_ARGS,
    )) as ControlShape;
    expect(first.control?.guidance).toHaveLength(1);
    const second = (await tool(ReticleTool.ACT).handler(
      fakeDeps(session),
      ACT_ARGS,
    )) as ControlShape;
    expect('control' in second).toBe(false);
  });

  it('active act with empty inbox has no control field', async () => {
    const session = fakeSession({ state: SessionState.ACTIVE, inbox: [] });
    const res = (await tool(ReticleTool.ACT).handler(fakeDeps(session), ACT_ARGS)) as ControlShape;
    expect('control' in res).toBe(false);
  });

  it('reticle_act_and_wait piggybacks control when active + pending msg', async () => {
    const session = fakeSession({ state: SessionState.ACTIVE, inbox: ['hi'] });
    const res = (await tool(ReticleTool.ACT_AND_WAIT).handler(fakeDeps(session), {
      ...ACT_ARGS,
      until: { kind: 'console', level: 'error', absent: true },
      timeout_ms: 0,
    })) as ControlShape;
    expect('effect' in res).toBe(true);
    expect('verdict' in res).toBe(true);
    expect('trace' in res).toBe(true);
    expect(res.control?.guidance).toHaveLength(1);
  });

  it('reticle_act_and_wait with no `until` defaults to waiting for the page to settle', async () => {
    const session = fakeSession({ state: SessionState.ACTIVE, inbox: [] });
    const res = (await tool(ReticleTool.ACT_AND_WAIT).handler(fakeDeps(session), {
      ...ACT_ARGS,
      timeout_ms: 50,
    })) as ControlShape;
    // No buffered activity (eventsSince → []) → the implicit `settled` predicate passes at once.
    const verdict = res.verdict as { pass: boolean; evidence?: { settled?: boolean } };
    expect(verdict.pass).toBe(true);
    expect(verdict.evidence?.settled).toBe(true);
    expect(session.__sent.filter((c) => 'act' === c.name)).toHaveLength(1);
  });

  it('reticle_assert piggybacks control while paused (observe-only)', async () => {
    const session = fakeSession({ state: SessionState.PAUSED, inbox: ['note'] });
    const res = (await tool(ReticleTool.ASSERT).handler(fakeDeps(session), {
      predicate: { kind: 'console', level: 'error', absent: true },
    })) as ControlShape;
    expect(res.control).toEqual({
      state: SessionState.PAUSED,
      guidance: ['note'],
    });
  });

  it('ended state does not short-circuit act but piggybacks state', async () => {
    const session = fakeSession({ state: SessionState.ENDED, inbox: [] });
    const res = (await tool(ReticleTool.ACT).handler(fakeDeps(session), ACT_ARGS)) as ControlShape &
      PausedShape;
    expect('paused' in res).toBe(false);
    expect(session.__sent.filter((c) => 'act' === c.name)).toHaveLength(1);
    expect(res.control).toEqual({ state: SessionState.ENDED, guidance: [] });
  });
});

describe('live-control: read tools stay open while paused', () => {
  it('read tools are NOT blocked by pause — snapshot', async () => {
    const session = fakeSession({ state: SessionState.PAUSED });
    await tool(ReticleTool.SNAPSHOT).handler(fakeDeps(session), {});
    expect(session.__sent.filter((c) => 'snapshot' === c.name)).toHaveLength(1);
  });

  it('read tools are NOT blocked by pause — query', async () => {
    const session = fakeSession({ state: SessionState.PAUSED });
    const res = (await tool(ReticleTool.QUERY).handler(fakeDeps(session), {
      by: 'role',
      value: 'button',
    })) as PausedShape;
    expect('paused' in res).toBe(false);
    expect(session.__sent.filter((c) => 'query' === c.name)).toHaveLength(1);
  });
});

describe('live-control: agent tools', () => {
  it('reticle_resume after pause lets the next act execute', async () => {
    const session = fakeSession({ state: SessionState.PAUSED });
    const resume = (await tool(ReticleTool.SESSION).handler(fakeDeps(session), {
      action: 'resume',
    })) as {
      ok: boolean;
    };
    expect(resume.ok).toBe(true);
    expect(session.__pushed.at(-1)).toEqual({ state: SessionState.ACTIVE });
    const act = (await tool(ReticleTool.ACT).handler(fakeDeps(session), ACT_ARGS)) as ControlShape;
    expect('result' in act).toBe(true);
    expect(session.__sent.filter((c) => 'act' === c.name)).toHaveLength(1);
  });

  it('reticle_resume returns ok and pushes PRESENTER', async () => {
    const session = fakeSession({ state: SessionState.PAUSED });
    const res = (await tool(ReticleTool.SESSION).handler(fakeDeps(session), {
      action: 'resume',
    })) as {
      ok: boolean;
    };
    expect(res.ok).toBe(true);
    expect(session.getState()).toBe(SessionState.ACTIVE);
    // Exactly one PRESENTER push for the transition (no redundant second push).
    expect(session.__pushed).toEqual([{ state: SessionState.ACTIVE }]);
  });

  it('reticle_end_session sets ended and pushes PRESENTER', async () => {
    const session = fakeSession({ state: SessionState.ACTIVE });
    const res = (await tool(ReticleTool.SESSION).handler(fakeDeps(session), {
      action: 'end',
      summary: 'done',
    })) as { ended: boolean; sessionId: string };
    expect(res).toEqual({ ended: true, sessionId: 'demo' });
    expect(session.getState()).toBe(SessionState.ENDED);
    // Single push carrying the summary — never a textless push followed by the summary push.
    expect(session.__pushed).toEqual([{ state: SessionState.ENDED, text: 'done' }]);
  });

  it('reticle_end_session works with no summary', async () => {
    const session = fakeSession({ state: SessionState.ACTIVE });
    const res = (await tool(ReticleTool.SESSION).handler(fakeDeps(session), { action: 'end' })) as {
      ended: boolean;
      sessionId: string;
    };
    expect(res).toEqual({ ended: true, sessionId: 'demo' });
    expect(session.__pushed).toContainEqual({ state: SessionState.ENDED });
  });

  it('reticle_end_session is idempotent', async () => {
    const session = fakeSession({ state: SessionState.ENDED });
    const res = (await tool(ReticleTool.SESSION).handler(fakeDeps(session), { action: 'end' })) as {
      ended: boolean;
      sessionId: string;
    };
    expect(res).toEqual({ ended: true, sessionId: 'demo' });
  });

  it('reticle_yield mode:waiting hands back with a waiting tone (revivable)', async () => {
    const session = fakeSession({ state: SessionState.ACTIVE });
    const res = (await tool(ReticleTool.SESSION).handler(fakeDeps(session), {
      action: 'yield',
      mode: 'waiting',
    })) as {
      yielded: boolean;
      mode: string;
      sessionId: string;
    };
    expect(res).toEqual({ yielded: true, mode: 'waiting', sessionId: 'demo' });
    expect(session.getState()).toBe(SessionState.ENDED);
    const push = session.__pushed.at(-1);
    expect(push?.state).toBe(SessionState.ENDED);
    expect(push?.tone).toBe('waiting');
    expect(push?.text).toContain('your move');
  });

  it('reticle_yield mode:ask carries the question and an ask tone', async () => {
    const session = fakeSession({ state: SessionState.ACTIVE });
    const res = (await tool(ReticleTool.SESSION).handler(fakeDeps(session), {
      action: 'yield',
      mode: 'ask',
      note: 'Use Stripe or Paddle?',
    })) as { yielded: boolean; mode: string; sessionId: string };
    expect(res.mode).toBe('ask');
    const push = session.__pushed.at(-1);
    expect(push?.tone).toBe('ask');
    expect(push?.text).toContain('Use Stripe or Paddle?');
  });

  it('reticle_messages drains the inbox', async () => {
    const session = fakeSession({ inbox: ['m1', 'm2'] });
    const first = (await tool(ReticleTool.SESSION).handler(fakeDeps(session), {
      action: 'messages',
    })) as {
      messages: InboxMessage[];
    };
    expect(first.messages).toEqual([
      { text: 'm1', t: 0 },
      { text: 'm2', t: 0 },
    ]);
    const second = (await tool(ReticleTool.SESSION).handler(fakeDeps(session), {
      action: 'messages',
    })) as {
      messages: InboxMessage[];
    };
    expect(second.messages).toEqual([]);
  });
});
