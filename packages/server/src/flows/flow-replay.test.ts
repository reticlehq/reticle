import { describe, expect, it, vi } from 'vitest';
import {
  ActionType,
  AnchorKind,
  DriftReason,
  EventType,
  FLOW_FILE_VERSION,
  IrisCommand,
  type CommandResult,
  type ElementDescriptor,
  type FlowFile,
  type FlowStep,
  type IrisEvent,
  type QueryEmptyHint,
} from '@syrin/iris-protocol';
import { nearestTestid, replayFlow, type FlowReplaySession } from './flow-replay.js';
import { waitForPredicate, type Predicate } from '../events/predicate.js';
import { asString } from '../tools/tools-helpers.js';
import { IrisTool } from '../tools/tool-names.js';

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
  readonly queries: string[] = [];

  constructor(
    private readonly queryScript: (testid: string) => QueryScript,
    private readonly events: IrisEvent[] = [],
    private readonly actOk: (ref: string) => boolean = PASS,
  ) {}

  command(name: string, args: Record<string, unknown> = {}): Promise<CommandResult> {
    if (name === IrisCommand.QUERY) {
      const value = asString(args['value']) ?? '';
      this.queries.push(value);
      return Promise.resolve({
        kind: 'command_result',
        id: 'q',
        ok: true,
        result: this.queryScript(value),
      });
    }
    if (name === IrisCommand.ACT) {
      const ref = asString(args['ref']) ?? '';
      this.acts.push({ ref, action: asString(args['action']) ?? '' });
      return Promise.resolve({
        kind: 'command_result',
        id: 'a',
        ok: this.actOk(ref),
        result: {},
        ...(this.actOk(ref) ? {} : { error: 'act failed' }),
      } as CommandResult);
    }
    return Promise.resolve({ kind: 'command_result', id: 'x', ok: true, result: {} });
  }

  eventsSince(): IrisEvent[] {
    return this.events;
  }

  onEvent(): () => void {
    return () => undefined;
  }
}

function el(ref: string, testid: string): ElementDescriptor {
  return { ref, role: 'button', name: testid, states: [], visible: true };
}

function present(testids: string[]): QueryEmptyHint {
  return { route: '/', presentTestids: testids, knownEmptyState: false };
}

function testidStep(value: string, action: ActionType = ActionType.CLICK): FlowStep {
  return { tool: IrisTool.ACT, anchor: { kind: AnchorKind.TESTID, value }, action, args: {} };
}

function signalStep(name: string): FlowStep {
  return { tool: IrisTool.ACT, anchor: { kind: AnchorKind.SIGNAL, name } };
}

function flow(steps: FlowStep[]): FlowFile {
  return { version: FLOW_FILE_VERSION, name: 'f', createdAt: 0, steps };
}

function signalEvent(name: string): IrisEvent {
  return { t: 1, type: EventType.SIGNAL, sessionId: 's', data: { name } };
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
