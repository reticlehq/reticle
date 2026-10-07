/**
 * A replayed "no console errors" step must not pass over an error the step itself caused (#1344).
 *
 * The click handler called `setTimeout(() => console.error('boom'), 800)`. The absence was held for
 * 300ms, the step read `ok: true`, and the error landed after the step's window had closed, so the
 * run said the console was clean.
 */

import { describe, expect, it } from 'vitest';
import {
  asRef,
  ActionType,
  AnchorKind,
  EventType,
  FLOW_FILE_VERSION,
  ReticleCommand,
  ReticleTool,
  type CommandResult,
  type FlowFile,
  type FlowStep,
  type ReticleEvent,
} from '@reticlehq/core';
import { waitForPredicate } from '@reticlehq/engine/question/predicate/predicate.js';
import { replayFlow } from './flow-replay.js';
import type { FlowReplaySession, WaitForSignal } from './flow-replay-types.js';

const BUTTON = 'save';
const STEP_TIMEOUT_MS = 3_000;
const LATE_ERROR_MS = 800;
const BOOM = 'boom';
const CONSOLE_ABSENT = { kind: 'console', level: 'error', absent: true } as const;

/** A page whose click schedules work, on a clock that moves. */
class Page implements FlowReplaySession {
  readonly #events: ReticleEvent[] = [];
  readonly #listeners = new Set<(event: ReticleEvent) => void>();
  readonly #started = performance.now();

  constructor(private readonly onClick: (page: Page) => void) {}

  elapsed(): number {
    return performance.now() - this.#started;
  }
  push(type: EventType, data: Record<string, unknown>): void {
    const event = { type, t: this.elapsed(), data } as unknown as ReticleEvent;
    this.#events.push(event);
    for (const listener of this.#listeners) listener(event);
  }
  command(name: string): Promise<CommandResult> {
    if (ReticleCommand.QUERY === name) {
      return Promise.resolve({
        kind: 'command_result',
        id: 'q',
        ok: true,
        result: {
          elements: [
            { ref: asRef('e-1'), role: 'button', name: BUTTON, states: [], visible: true },
          ],
          hint: { route: '/', presentTestids: [BUTTON], knownEmptyState: false },
        },
      });
    }
    if (ReticleCommand.ACT === name) this.onClick(this);
    return Promise.resolve({ kind: 'command_result', id: 'x', ok: true, result: {} });
  }
  eventsSince(cursor = 0): ReticleEvent[] {
    return this.#events.filter((e) => e.t >= cursor);
  }
  onEvent(listener: (event: ReticleEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
}

function flow(): FlowFile {
  const step: FlowStep = {
    tool: ReticleTool.ACT,
    anchor: { kind: AnchorKind.TESTID, value: BUTTON },
    action: ActionType.CLICK,
    args: {},
    expect: CONSOLE_ABSENT,
  };
  return { version: FLOW_FILE_VERSION, name: 'f', createdAt: 0, steps: [step] };
}

describe('a console-absent step replays the error its own action scheduled', () => {
  it('drifts when the error lands 800ms after the click', async () => {
    const page = new Page((p) => {
      setTimeout(() => {
        p.push(EventType.CONSOLE_ERROR, { message: BOOM });
      }, LATE_ERROR_MS);
    });
    const [step] = await replayFlow(page, flow(), waitForPredicate, STEP_TIMEOUT_MS);
    expect(step?.ok).toBe(false);
    expect(step?.drift).toBeDefined();
  });

  it('a step whose consequence counts a console error cannot pass a console-absent expect', async () => {
    // The wait said yes; the window the consequence is read from says otherwise. The window wins.
    const page = new Page((p) => {
      p.push(EventType.CONSOLE_ERROR, { message: BOOM });
    });
    const saidYes: WaitForSignal = () => Promise.resolve({ pass: true });
    const [step] = await replayFlow(page, flow(), saidYes, STEP_TIMEOUT_MS);
    expect(step?.consequence).toContain('console error');
    expect(step?.ok).toBe(false);
    expect(step?.drift).toBeDefined();
  });

  it('carries the console errors its window saw, for the run artifact to report', async () => {
    const page = new Page((p) => {
      p.push(EventType.CONSOLE_ERROR, { message: BOOM });
    });
    const [step] = await replayFlow(page, flow(), waitForPredicate, STEP_TIMEOUT_MS);
    expect(step?.consoleErrors).toEqual([
      expect.objectContaining({ level: EventType.CONSOLE_ERROR, message: BOOM }),
    ]);
  });

  it('a clean click still passes and carries no console errors', async () => {
    const page = new Page(() => undefined);
    const [step] = await replayFlow(page, flow(), waitForPredicate, STEP_TIMEOUT_MS);
    expect(step?.ok).toBe(true);
    expect(step?.consoleErrors).toBeUndefined();
  });
});
