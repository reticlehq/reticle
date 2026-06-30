import { describe, expect, it, vi } from 'vitest';
import {
  ActionType,
  AnchorKind,
  DANGEROUS_ACTION_CONFIRM_ARG,
  DriftReason,
  EventType,
  FLOW_FILE_VERSION,
  ReticleCommand,
  type CommandResult,
  type ElementDescriptor,
  type FlowFile,
  type FlowStep,
  type ReticleEvent,
  type QueryEmptyHint,
} from '@reticlehq/protocol';
import {
  nearestTestid,
  nearestIsAmbiguous,
  replayFlow,
  type FlowReplaySession,
} from './flow-replay.js';
import { waitForPredicate, type Predicate } from '../events/predicate.js';
import { asRecord, asString } from '../tools/tools-helpers.js';
import { ReticleTool } from '../tools/tool-names.js';

/** A scripted QUERY response per testid: live elements + (on zero) the present-testids near-miss. */
interface QueryScript {
  elements: ElementDescriptor[];
  hint?: QueryEmptyHint;
}

const PASS = (): boolean => true;

/**
 * In-memory session for the anchor-resolution engine. QUERY answers from a per-testid script
 * (so a renamed testid scripts zero matches + presentTestids); ACT/ACT_SEQUENCE record calls
 * and answer ok; events drive signal predicates. Never launches a browser.
 */
class FakeSession implements FlowReplaySession {
  readonly acts: { ref: string; action: string }[] = [];
  readonly actArgs: Record<string, unknown>[] = [];
  readonly queries: string[] = [];

  constructor(
    private readonly queryScript: (testid: string) => QueryScript,
    private readonly events: ReticleEvent[] = [],
    private readonly actOk: (ref: string) => boolean = PASS,
    private readonly stores: Record<string, unknown> = {},
  ) {}

  command(name: string, args: Record<string, unknown> = {}): Promise<CommandResult> {
    if (name === ReticleCommand.QUERY) {
      const value = asString(args['value']) ?? '';
      this.queries.push(value);
      return Promise.resolve({
        kind: 'command_result',
        id: 'q',
        ok: true,
        result: this.queryScript(value),
      });
    }
    if (name === ReticleCommand.ACT) {
      const ref = asString(args['ref']) ?? '';
      this.acts.push({ ref, action: asString(args['action']) ?? '' });
      this.actArgs.push(asRecord(args['args']));
      return Promise.resolve({
        kind: 'command_result',
        id: 'a',
        ok: this.actOk(ref),
        result: {},
        ...(this.actOk(ref) ? {} : { error: 'act failed' }),
      } as CommandResult);
    }
    if (name === ReticleCommand.STATE_READ) {
      return Promise.resolve({
        kind: 'command_result',
        id: 's',
        ok: true,
        result: { stores: this.stores, storeNames: Object.keys(this.stores) },
      });
    }
    return Promise.resolve({ kind: 'command_result', id: 'x', ok: true, result: {} });
  }

  eventsSince(): ReticleEvent[] {
    return this.events;
  }

  onEvent(): () => void {
    return () => undefined;
  }

  elapsed(): number {
    return 0;
  }
}

function el(ref: string, testid: string): ElementDescriptor {
  return { ref, role: 'button', name: testid, states: [], visible: true };
}

function present(testids: string[]): QueryEmptyHint {
  return { route: '/', presentTestids: testids, presentRegions: [], knownEmptyState: false };
}

function testidStep(value: string, action: ActionType = ActionType.CLICK): FlowStep {
  return { tool: ReticleTool.ACT, anchor: { kind: AnchorKind.TESTID, value }, action, args: {} };
}

function signalStep(name: string): FlowStep {
  return { tool: ReticleTool.ACT, anchor: { kind: AnchorKind.SIGNAL, name } };
}

function flow(steps: FlowStep[]): FlowFile {
  return { version: FLOW_FILE_VERSION, name: 'f', createdAt: 0, steps };
}

function signalEvent(name: string): ReticleEvent {
  return { t: 1, type: EventType.SIGNAL, sessionId: 's', data: { name } };
}

function routeEvent(pathname: string): ReticleEvent {
  return { t: 1, type: EventType.ROUTE_CHANGE, sessionId: 's', data: { pathname } };
}

function netEvent(method: string, url: string, status: number): ReticleEvent {
  return { t: 1, type: EventType.NET_REQUEST, sessionId: 's', data: { method, url, status } };
}

const FAST = 60; // short signal timeout so the miss case resolves quickly

describe('replayFlow — anchor re-resolution + legible drift', () => {
  it('1: replays green when every testid resolves', async () => {
    const script = (testid: string): QueryScript => ({ elements: [el(`e-${testid}`, testid)] });
    const session = new FakeSession(script);
    const steps = await replayFlow(
      session,
      flow([testidStep('chat-send'), testidStep('chat-input', ActionType.FILL)]),
      waitForPredicate,
      FAST,
    );

    expect(steps).toHaveLength(2);
    expect(steps.every((s) => s.ok)).toBe(true);
    expect(steps.every((s) => s.drift === undefined)).toBe(true);
    // One ACT issued per resolved step, against the live ref the query returned.
    expect(session.acts).toEqual([
      { ref: 'e-chat-send', action: ActionType.CLICK },
      { ref: 'e-chat-input', action: ActionType.FILL },
    ]);
  });

  it('captures the page (route) each step ran on — the journey trail', async () => {
    const script = (testid: string): QueryScript => ({ elements: [el(`e-${testid}`, testid)] });
    const session = new FakeSession(script, [routeEvent('/deployments')]);
    const steps = await replayFlow(
      session,
      flow([testidStep('new-deploy'), testidStep('deploy-submit')]),
      waitForPredicate,
      FAST,
    );

    expect(steps).toHaveLength(2);
    // Each resolved step records which page it ran on (read from the latest route change).
    expect(steps[0]?.page).toBe('/deployments');
    expect(steps[1]?.page).toBe('/deployments');
  });

  it('summarizes the consequence after a step — route, signal, and network in one terse line', async () => {
    const script = (testid: string): QueryScript => ({ elements: [el(`e-${testid}`, testid)] });
    const session = new FakeSession(script, [
      routeEvent('/deployments'),
      signalEvent('modal:opened'),
      netEvent('POST', 'http://localhost/api/deploys?x=1', 201),
    ]);
    const steps = await replayFlow(
      session,
      flow([testidStep('new-deploy')]),
      waitForPredicate,
      FAST,
    );
    const consequence = steps[0]?.consequence ?? '';
    expect(consequence).toContain('→ /deployments');
    expect(consequence).toContain('signal modal:opened');
    expect(consequence).toContain('POST /api/deploys 201'); // origin + query trimmed
  });

  it('omits page when no route has been observed (stays optional)', async () => {
    const script = (testid: string): QueryScript => ({ elements: [el(`e-${testid}`, testid)] });
    const session = new FakeSession(script); // no events → no route
    const steps = await replayFlow(
      session,
      flow([testidStep('chat-send')]),
      waitForPredicate,
      FAST,
    );
    expect(steps[0]?.page).toBeUndefined();
  });

  it('resolves a component (auto-anchor) step and acts on the live ref', async () => {
    // No testid; the step is anchored by component/source. QUERY by:'component' resolves it.
    const script = (): QueryScript => ({ elements: [el('e-comp', 'new-deploy')] });
    const session = new FakeSession(script);
    const step: FlowStep = {
      tool: ReticleTool.ACT,
      anchor: {
        kind: AnchorKind.COMPONENT,
        component: 'NewDeployButton',
        source: { file: 'src/Deployments.tsx', line: 107 },
      },
      action: ActionType.CLICK,
      args: {},
    };
    const steps = await replayFlow(session, flow([step]), waitForPredicate, FAST);
    expect(steps[0]?.ok).toBe(true);
    expect(steps[0]?.anchor).toBe('NewDeployButton@Deployments.tsx:107');
    expect(session.acts).toEqual([{ ref: 'e-comp', action: ActionType.CLICK }]);
  });

  it('drifts legibly when a component anchor resolves to nothing (the element/source is gone)', async () => {
    const session = new FakeSession(() => ({ elements: [] }));
    const step: FlowStep = {
      tool: ReticleTool.ACT,
      anchor: { kind: AnchorKind.COMPONENT, component: 'NewDeployButton' },
      action: ActionType.CLICK,
      args: {},
    };
    const steps = await replayFlow(session, flow([step]), waitForPredicate, FAST);
    expect(steps[0]?.ok).toBe(false);
    expect(steps[0]?.drift?.reasonKind).toBe(DriftReason.COMPONENT_NOT_FOUND);
    expect(steps[0]?.anchor).toBe('NewDeployButton');
    expect(session.acts).toEqual([]); // stopped at the miss, never acted
  });

  it('2: returns drift with the nearest-match when a testid is renamed', async () => {
    const script = (testid: string): QueryScript =>
      testid === 'chat-send'
        ? { elements: [], hint: present(['chat-submit', 'sidebar-toggle']) }
        : { elements: [el(`e-${testid}`, testid)] };
    const session = new FakeSession(script);
    const steps = await replayFlow(
      session,
      flow([testidStep('chat-send'), testidStep('chat-input')]),
      waitForPredicate,
      FAST,
    );

    const last = steps.at(-1);
    expect(last?.ok).toBe(false);
    expect(last?.anchor).toBe('chat-send');
    expect(last?.drift?.reasonKind).toBe(DriftReason.TESTID_NOT_FOUND);
    expect(last?.drift?.reason).toBe('testid "chat-send" not found');
    // The nearest is COMPUTED, not null.
    expect(last?.drift?.nearest).not.toBeNull();
    expect(last?.drift?.nearest).toBe('chat-submit');
    // Replay STOPS at the miss — the second step never ran an ACT.
    expect(session.acts).toEqual([]);
    expect(steps).toHaveLength(1);
  });

  it('3: a testid-preserving change still replays green (anchors are testid-only)', async () => {
    // The element's role/name differ from record time, but the testid matches → resolves.
    const script = (): QueryScript => ({
      elements: [
        { ref: 'e1', role: 'link', name: 'totally different label', states: [], visible: true },
      ],
    });
    const session = new FakeSession(script);
    const steps = await replayFlow(
      session,
      flow([testidStep('chat-send')]),
      waitForPredicate,
      FAST,
    );

    expect(steps[0]?.ok).toBe(true);
    expect(steps[0]?.drift).toBeUndefined();
    expect(session.acts).toEqual([{ ref: 'e1', action: ActionType.CLICK }]);
  });

  it('requires a fresh destructive-action confirmation for each replay', async () => {
    const step = testidStep('delete-account');
    step.args = { [DANGEROUS_ACTION_CONFIRM_ARG]: true };
    const script = (testid: string): QueryScript => ({ elements: [el(`e-${testid}`, testid)] });

    const unconfirmed = new FakeSession(script);
    await replayFlow(unconfirmed, flow([step]), waitForPredicate, FAST);
    expect(unconfirmed.actArgs[0]).not.toHaveProperty(DANGEROUS_ACTION_CONFIRM_ARG);

    const confirmed = new FakeSession(script);
    await replayFlow(confirmed, flow([step]), waitForPredicate, FAST, true);
    expect(confirmed.actArgs[0]).toMatchObject({ [DANGEROUS_ACTION_CONFIRM_ARG]: true });
  });

  it('settles an in-flight render: a testid empty at first, then present, resolves (no false drift)', async () => {
    // The element appears on the 3rd query — an async route swap / list paint, not a regression.
    let calls = 0;
    const script = (testid: string): QueryScript => {
      if (testid !== 'late-button') return { elements: [el(`e-${testid}`, testid)] };
      calls += 1;
      return calls < 3
        ? { elements: [], hint: present(['other']) }
        : { elements: [el('e-late', testid)] };
    };
    const session = new FakeSession(script);
    const noopSleep = vi.fn((): Promise<void> => Promise.resolve());
    const steps = await replayFlow(
      session,
      flow([testidStep('late-button')]),
      waitForPredicate,
      FAST,
      false,
      noopSleep,
    );

    expect(steps[0]?.ok).toBe(true);
    expect(steps[0]?.drift).toBeUndefined();
    expect(session.acts).toEqual([{ ref: 'e-late', action: ActionType.CLICK }]);
    expect(noopSleep).toHaveBeenCalled(); // it actually waited between re-queries
  });

  it('still drifts when a testid is missing across every settle attempt (a real regression)', async () => {
    let calls = 0;
    const script = (): QueryScript => {
      calls += 1;
      return { elements: [], hint: present(['nav-overview']) };
    };
    const session = new FakeSession(script);
    const noopSleep = (): Promise<void> => Promise.resolve();
    const steps = await replayFlow(
      session,
      flow([testidStep('nav-compose')]),
      waitForPredicate,
      FAST,
      false,
      noopSleep,
    );

    expect(steps[0]?.ok).toBe(false);
    expect(steps[0]?.drift?.reasonKind).toBe(DriftReason.TESTID_NOT_FOUND);
    expect(steps[0]?.drift?.nearest).toBe('nav-overview');
    expect(calls).toBeGreaterThan(1); // it retried before concluding the anchor is gone
  });

  it('6: a signal-expect step waits on the signal predicate (reuses predicate.ts)', async () => {
    const session = new FakeSession(() => ({ elements: [] }), [signalEvent('order-placed')]);
    const waitSpy = vi.fn(waitForPredicate);
    const steps = await replayFlow(session, flow([signalStep('order-placed')]), waitSpy, FAST);

    expect(steps[0]?.ok).toBe(true);
    expect(steps[0]?.drift).toBeUndefined();
    // Proves predicate reuse: the injected wait fn was invoked with a {signal} predicate.
    expect(waitSpy).toHaveBeenCalledTimes(1);
    const predicate = waitSpy.mock.calls[0]?.[1] as Predicate;
    expect(predicate).toEqual({ kind: 'signal', name: 'order-placed' });
  });

  it('7: an unobserved signal drifts (not a blind fail) and stops', async () => {
    const session = new FakeSession(() => ({ elements: [] }), []); // no events → never observed
    const steps = await replayFlow(
      session,
      flow([signalStep('never-fires'), testidStep('after')]),
      waitForPredicate,
      FAST,
    );

    const last = steps.at(-1);
    expect(last?.ok).toBe(false);
    expect(last?.drift?.reasonKind).toBe(DriftReason.SIGNAL_NOT_OBSERVED);
    expect(last?.anchor).toBe('never-fires');
    expect(last?.drift?.nearest).toBeNull();
    expect(steps).toHaveLength(1); // stopped before the testid step
    expect(session.acts).toEqual([]);
  });

  it('9: a step expect.state holds against the store → green', async () => {
    const script = (testid: string): QueryScript => ({ elements: [el(`e-${testid}`, testid)] });
    const stores = { app: { deployments: [{ status: 'live' }] } };
    const session = new FakeSession(script, [], PASS, stores);
    const step: FlowStep = {
      ...testidStep('ship'),
      expect: { state: { store: 'app', path: 'deployments.0.status', equals: 'live' } },
    };
    const steps = await replayFlow(session, flow([step]), waitForPredicate, FAST);
    expect(steps.at(-1)?.ok).toBe(true);
  });

  it('10: a step expect.state that lies about the store drifts (STATE_MISMATCH), not a blind pass', async () => {
    // The DOM action ran fine, but the store says 'queued' — a deploy that only LOOKS shipped.
    const script = (testid: string): QueryScript => ({ elements: [el(`e-${testid}`, testid)] });
    const stores = { app: { deployments: [{ status: 'queued' }] } };
    const session = new FakeSession(script, [], PASS, stores);
    const step: FlowStep = {
      ...testidStep('ship'),
      expect: { state: { store: 'app', path: 'deployments.0.status', equals: 'live' } },
    };
    const steps = await replayFlow(session, flow([step]), waitForPredicate, FAST);
    const last = steps.at(-1);
    expect(last?.ok).toBe(false);
    expect(last?.drift?.reasonKind).toBe(DriftReason.STATE_MISMATCH);
    expect(last?.drift?.reason).toContain('queued');
  });
});

describe('nearestTestid — closest surviving anchor', () => {
  it('8: computes the closest by edit distance, null only when none present', () => {
    expect(nearestTestid('chat-send', ['chat-submit', 'sidebar'])).toBe('chat-submit');
    expect(nearestTestid('x', [])).toBeNull();
  });

  it('8b: ties broken by shortest, case-insensitive', () => {
    expect(nearestTestid('Send', ['send-x', 'send'])).toBe('send');
  });
});

describe('nearestIsAmbiguous — refuse to auto-heal a coin-flip', () => {
  it('is true when two candidates tie at the minimum distance', () => {
    // both differ from "submit-bt" by one edit → tie → arbitrary pick → ambiguous
    expect(nearestIsAmbiguous('submit-bt', ['submit-btn', 'submit-bts'])).toBe(true);
  });

  it('is false when one candidate is strictly closest', () => {
    expect(nearestIsAmbiguous('chat-send', ['chat-send-x', 'sidebar'])).toBe(false);
  });

  it('is false with fewer than two candidates', () => {
    expect(nearestIsAmbiguous('x', [])).toBe(false);
    expect(nearestIsAmbiguous('x', ['y'])).toBe(false);
  });
});
