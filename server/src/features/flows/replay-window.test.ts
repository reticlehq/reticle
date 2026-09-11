import { describe, expect, it } from 'vitest';
import {
  asRef,
  ActionType,
  AnchorKind,
  FLOW_FILE_VERSION,
  ReticleCommand,
  ReticleTool,
  asString,
  type CommandResult,
  type ElementDescriptor,
  type FlowFile,
  type FlowStep,
} from '@reticlehq/core';
import { replayFlow, type FlowReplaySession } from './flow-replay.js';
import { waitForPredicate } from '@reticlehq/engine/question/predicate/predicate.js';

/**
 * A replayed step has to say WHERE its evidence is.
 *
 * A deterministic run is the path designed to execute forever, and it reported `{ok, error?, note?}`
 * plus a terse prose `consequence` — enough to say a step passed, not enough to ask what it did. The
 * evidence IS captured while a replay runs (the observers are installed, the events land), so this is
 * a surfacing change, not a capture change.
 *
 * The cursor pair is the whole unlock: `reticle_observe` already accepts `{ since, until }` —
 * "returns the span between action A and B" — so a step that carries its own window is a step an
 * agent can drill into afterwards without re-driving anything. Without it, the evidence exists and
 * has no address.
 */
const FAST = 60;

function el(ref: string, testid: string): ElementDescriptor {
  return { ref: asRef(ref), role: 'button', name: testid, states: [], visible: true };
}

/** A clock that advances on every read, so each step occupies a distinct span. */
class TickingSession implements FlowReplaySession {
  #now = 0;
  constructor(private readonly present: Set<string>) {}

  command(name: string, args: Record<string, unknown> = {}): Promise<CommandResult> {
    this.#now += 5;
    if (name === ReticleCommand.QUERY) {
      const value = asString(args['value']) ?? '';
      const elements = this.present.has(value) ? [el(`e-${value}`, value)] : [];
      return Promise.resolve({
        kind: 'command_result',
        id: 'q',
        ok: true,
        result: {
          elements,
          hint: { route: '/', presentTestids: [...this.present], knownEmptyState: false },
        },
      });
    }
    return Promise.resolve({ kind: 'command_result', id: 'x', ok: true, result: {} });
  }
  eventsSince(): never[] {
    return [];
  }
  onEvent(): () => void {
    return () => undefined;
  }
  elapsed(): number {
    return this.#now;
  }
}

function step(value: string): FlowStep {
  return {
    tool: ReticleTool.ACT,
    anchor: { kind: AnchorKind.TESTID, value },
    action: ActionType.CLICK,
    args: {},
  };
}

function flow(values: string[]): FlowFile {
  return { version: FLOW_FILE_VERSION, name: 'f', createdAt: 0, steps: values.map(step) };
}

describe('a replayed step carries the window its evidence lives in', () => {
  it('reports the cursor pair, so `observe { since, until }` can drill into that step alone', async () => {
    const results = await replayFlow(
      new TickingSession(new Set(['one', 'two'])),
      flow(['one', 'two']),
      waitForPredicate,
      FAST,
    );

    expect(results[0]?.window).toBeDefined();
    expect(results[0]?.window?.since).toBeTypeOf('number');
    expect(results[0]?.window?.until).toBeGreaterThan(results[0]?.window?.since ?? 0);
  });

  it('gives each step its OWN span, so one step`s evidence is not another`s', async () => {
    // The whole point of a bounded window: a shared cursor would let step one's consequence answer
    // for step two, which is a false green assembled out of correct parts.
    const results = await replayFlow(
      new TickingSession(new Set(['one', 'two'])),
      flow(['one', 'two']),
      waitForPredicate,
      FAST,
    );

    const first = results[0]?.window;
    const second = results[1]?.window;
    expect(second?.since).toBeGreaterThanOrEqual(first?.until ?? 0);
  });

  it('is omitted where no clock advanced rather than reported as a zero-width lie', async () => {
    class Frozen extends TickingSession {
      override elapsed(): number {
        return 0;
      }
    }
    const results = await replayFlow(
      new Frozen(new Set(['one'])),
      flow(['one']),
      waitForPredicate,
      FAST,
    );
    expect(results[0]?.window).toBeUndefined();
  });
});

describe('a replayed step carries the structured digest of what the app did', () => {
  it('reports counts, not just a prose consequence', async () => {
    // `consequence` is a sentence — readable, and not scannable. Twenty-five of them is prose to
    // read; twenty-five digests is a surface to scan, which is the whole difference between a step
    // ledger an agent skims and one it has to parse.
    const results = await replayFlow(
      new TickingSession(new Set(['one'])),
      flow(['one']),
      waitForPredicate,
      FAST,
    );

    expect(results[0]?.digest).toBeDefined();
    expect(results[0]?.digest?.summary.total).toBeTypeOf('number');
    expect(results[0]?.digest?.summary).toHaveProperty('consoleErrors');
    expect(results[0]?.digest?.summary).toHaveProperty('network');
    expect(results[0]?.digest?.summary).toHaveProperty('signals');
  });
});
