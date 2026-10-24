import { describe, expect, it } from 'vitest';
import {
  asRef,
  ActionType,
  AnchorKind,
  EventType,
  FLOW_FILE_VERSION,
  ReticleCommand,
  ReticleTool,
  asString,
  type CommandResult,
  type ElementDescriptor,
  type FlowFile,
  type FlowStep,
  type Predicate,
  type ReticleEvent,
} from '@reticlehq/core';
import { replayFlow, type FlowReplaySession } from './flow-replay.js';
import { waitForPredicate } from '@reticlehq/engine/question/predicate/predicate.js';

/**
 * Replay judges each sub-step `expect` of a sequence in the window of that sub-step.
 *
 * Replay checked every sub-step `expect` once, after the last sub-step. A route expect on a middle
 * sub-step then failed, because a later sub-step had moved on. A claim on a later sub-step could
 * also pass on a request that an earlier sub-step sent.
 */
const FAST = 60;

/** What each sub-step's action does to the page, by the test id it clicks. */
type Effect = (push: (type: EventType, data: Record<string, unknown>) => void) => void;

class PageSession implements FlowReplaySession {
  #now = 0;
  readonly #events: ReticleEvent[] = [];
  constructor(private readonly effects: Record<string, Effect>) {}

  #push = (type: EventType, data: Record<string, unknown>): void => {
    this.#now += 1;
    this.#events.push({ t: this.#now, seq: this.#now, type, sessionId: 's', data });
    // The page moves on after it reports, so the next cursor is after this event.
    this.#now += 1;
  };

  command(name: string, args: Record<string, unknown> = {}): Promise<CommandResult> {
    this.#now += 5;
    if (name === ReticleCommand.QUERY) {
      const value = asString(args['value']) ?? '';
      const element: ElementDescriptor = {
        ref: asRef(`e-${value}`),
        role: 'button',
        name: value,
        states: [],
        visible: true,
      };
      return Promise.resolve({
        kind: 'command_result',
        id: 'q',
        ok: true,
        result: { elements: [element] },
      });
    }
    if (name === ReticleCommand.ACT_SEQUENCE) {
      const steps = Array.isArray(args['steps']) ? (args['steps'] as { ref: string }[]) : [];
      for (const step of steps) {
        this.effects[step.ref.replace(/^e-/, '')]?.(this.#push);
      }
    }
    return Promise.resolve({ kind: 'command_result', id: 'x', ok: true, result: {} });
  }
  eventsSince(since = 0): ReticleEvent[] {
    return this.#events.filter((e) => e.t >= since);
  }
  onEvent(): () => void {
    return () => undefined;
  }
  elapsed(): number {
    return this.#now;
  }
}

function sub(value: string, expectation?: Predicate): FlowStep {
  return {
    tool: ReticleTool.ACT,
    anchor: { kind: AnchorKind.TESTID, value },
    action: ActionType.CLICK,
    args: {},
    ...(expectation === undefined ? {} : { expect: expectation }),
  };
}

function sequence(subs: FlowStep[]): FlowFile {
  const step: FlowStep = {
    tool: ReticleTool.ACT_SEQUENCE,
    anchor: { kind: AnchorKind.TESTID, value: 'open-a' },
    steps: subs,
  };
  return { version: FLOW_FILE_VERSION, name: 'f', createdAt: 0, steps: [step] };
}

const goTo =
  (pathname: string): Effect =>
  (push) => {
    push(EventType.ROUTE_CHANGE, { pathname });
  };

describe('a sequence sub-step expect is judged in its own window', () => {
  it('passes route expects on each sub-step when a later sub-step moves on', async () => {
    const session = new PageSession({
      'open-a': goTo('/a'),
      'open-b': goTo('/b'),
      home: goTo('/'),
    });
    const results = await replayFlow(
      session,
      sequence([
        sub('open-a', { kind: 'route', pathname: '/a' }),
        sub('open-b', { kind: 'route', pathname: '/b' }),
        sub('home', { kind: 'route', pathname: '/' }),
      ]),
      waitForPredicate,
      FAST,
    );
    expect(results[0]?.drift).toBeUndefined();
    expect(results[0]?.ok).toBe(true);
  });

  it('does not pass a later sub-step claim on a request an earlier sub-step sent', async () => {
    const session = new PageSession({
      save: (push) => {
        push(EventType.NET_REQUEST, {
          id: 'n1',
          method: 'POST',
          url: '/api/save',
          status: 200,
          ok: true,
        });
      },
      close: () => undefined,
    });
    const results = await replayFlow(
      session,
      sequence([
        sub('save'),
        sub('close', { kind: 'net', method: 'POST', urlContains: '/api/save' }),
      ]),
      waitForPredicate,
      FAST,
    );
    expect(results[0]?.ok).toBe(false);
  });
});
