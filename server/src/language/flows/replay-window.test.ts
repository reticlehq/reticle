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

    //
    // The digest is SPARSE: `total` always, every other counter only when it is non-zero. This used
    // to assert `toHaveProperty('consoleErrors')` and `('network')` — i.e. that the zeros were spelled
    // out — which is the byte the route cut removed. An absent counter reads as zero, so what has to
    // hold is that the counts are a SURFACE (numbers keyed by channel), not that every key is sent.
    const summary = results[0]?.digest?.summary;
    expect(results[0]?.digest).toBeDefined();
    expect(summary?.total).toBeTypeOf('number');
    for (const [key, count] of Object.entries(summary ?? {})) {
      expect(count, `${key} is a count`).toBeTypeOf('number');
      // The whole point of the cut: nothing is sent just to say it did not happen.
      if ('total' !== key) expect(count, `${key} is present, so it moved`).not.toBe(0);
    }
  });
});

/**
 * Two facts, four numbers.
 *
 * `window {since, until}` is the drill address an agent passes straight to `reticle_observe`, and its
 * "bounded on BOTH ends" invariant is argued in core beside the type. `durationMs` was `until - since`
 * computed one line earlier, under the SAME emission condition — so every step shipped the subtraction
 * as well as its operands, on every step of every replay, forever.
 *
 * Removing a value the reader can compute from two others in the same object is a ROUTE cut: the fact
 * survives byte-for-byte. Removing `window.until` instead would save fewer bytes AND make the observe
 * address require arithmetic, which is the wrong half to drop.
 *
 * The `tool` field is the same shape of waste for a different reason: 137/137 steps in this repo's
 * corpus are `reticle_act`, and every reader only ever asks "is this the success oracle?". So it is
 * omitted when it holds the default and spelled out when it does not — read it as `tool ?? ACT`.
 */
describe('a replayed step does not ship what the reader can already compute', () => {
  it('omits durationMs — it is window.until minus window.since', async () => {
    const results = await replayFlow(
      new TickingSession(new Set(['one'])),
      flow(['one']),
      waitForPredicate,
      FAST,
    );

    const step = results[0];
    expect(step?.window, 'the window is the evidence and stays').toBeDefined();
    expect(step?.window?.until).toBeGreaterThan(step?.window?.since ?? 0);
    expect('durationMs' in (step ?? {}), 'durationMs is the subtraction, not a fact').toBe(false);
  });

  it('omits `tool` when it is the default, so a non-default still announces itself', async () => {
    const results = await replayFlow(
      new TickingSession(new Set(['one'])),
      flow(['one']),
      waitForPredicate,
      FAST,
    );

    expect('tool' in (results[0] ?? {}), 'reticle_act is the default — unsaid').toBe(false);
  });
});
