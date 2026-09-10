/**
 * A replayed step whose predecessor re-rendered the page must not die on a stale ref.
 *
 * Reported: a saved flow of `fill` then `click` fails with `ref 'eNNNN' no longer resolves to an
 * element`, a different ref each attempt — the fill triggers a re-render between the click step
 * resolving its element and dispatching at it. `reticle_flow_heal` correctly answers `unhealable`:
 * the locator is right, only the timing is wrong. And the flow format has no way to express a wait,
 * so there was nothing the user could do short of hand-editing JSON the format does not document.
 *
 * `act_sequence` already solved exactly this, for exactly this reason, and the reasoning is written
 * down in act-sequence-retry.ts. Replay is the same race with the same cure, so it uses the same
 * helper rather than a second one.
 *
 * The retry RE-RESOLVES. Re-dispatching the same dead ref would fail identically; what changed
 * between the two attempts is the DOM, so the locator has to be run against it again.
 *
 * Only staleness retries. A step that failed for any other reason is never re-run — a replay that
 * quietly repeats actions turns one click into two, which is worse than the failure it papers over.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  ActionType,
  AnchorKind,
  FlowStepTool,
  ReticleCommand,
  type CommandResult,
  type FlowStep,
} from '@reticlehq/core';
import { runStepWithStaleRetry } from '../../agent/tools/act/act-sequence-retry.js';
import { runRoleStep } from './flow-step-runners.js';
import type { FlowReplaySession } from './flow-replay.js';

const STALE = "ref 'e91' no longer resolves to an element";
const session = { eventsSince: () => [], elapsed: () => 0 };
const noSleep = { sleep: (): Promise<void> => Promise.resolve() };

describe('replaying a step across a re-render', () => {
  it('retries once when the ref went stale, and succeeds', async () => {
    const attempt = vi
      .fn<() => Promise<{ ok: boolean; error?: string }>>()
      .mockResolvedValueOnce({ ok: false, error: STALE })
      .mockResolvedValueOnce({ ok: true });
    const out = await runStepWithStaleRetry(attempt, session, 0, 50, noSleep);
    expect(out.ok).toBe(true);
    expect(attempt, 'exactly one retry, never a loop').toHaveBeenCalledTimes(2);
  });

  it('does NOT retry a failure that is not staleness', async () => {
    // A replay that quietly re-runs actions turns one click into two. Only the race is retried.
    const attempt = vi
      .fn<() => Promise<{ ok: boolean; error?: string }>>()
      .mockResolvedValue({ ok: false, error: 'element is disabled' });
    const out = await runStepWithStaleRetry(attempt, session, 0, 50, noSleep);
    expect(out.ok).toBe(false);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('does not retry a step that already worked', async () => {
    const attempt = vi.fn<() => Promise<{ ok: boolean }>>().mockResolvedValue({ ok: true });
    await runStepWithStaleRetry(attempt, session, 0, 50, noSleep);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('gives up after the one retry when the element is genuinely gone', async () => {
    const attempt = vi
      .fn<() => Promise<{ ok: boolean; error?: string }>>()
      .mockResolvedValue({ ok: false, error: STALE });
    const out = await runStepWithStaleRetry(attempt, session, 0, 50, noSleep);
    expect(out.ok).toBe(false);
    expect(attempt, 'a dead element must fail, not spin').toHaveBeenCalledTimes(2);
  });
});

/**
 * The wiring, driven through a runner — because the helper being correct proved nothing about the
 * replay path using it, which is the mistake that let a redacted secret go unsupplied on three of
 * four step paths in this same file's neighbourhood.
 */
describe('a role-anchored step survives a re-render', () => {
  it('re-resolves and succeeds when the first dispatch hits a stale ref', async () => {
    let acts = 0;
    let queries = 0;
    const session = {
      command: (name: string) => {
        if (ReticleCommand.QUERY === name) {
          queries += 1;
          return Promise.resolve({
            kind: 'command_result',
            id: 'q',
            ok: true,
            // A DIFFERENT ref after the re-render, which is exactly the reported symptom.
            result: { elements: [{ ref: `e${String(queries)}` }] },
          } as unknown as CommandResult);
        }
        acts += 1;
        return Promise.resolve(
          1 === acts
            ? {
                kind: 'command_result',
                id: 'a',
                ok: false,
                error: "ref 'e1' no longer resolves to an element",
              }
            : { kind: 'command_result', id: 'a', ok: true },
        );
      },
      eventsSince: () => [],
      onEvent: () => () => undefined,
      elapsed: () => 0,
    } as unknown as FlowReplaySession;

    const result = await runRoleStep(
      session,
      { tool: FlowStepTool.ACT, action: ActionType.CLICK, args: {} } as unknown as FlowStep,
      0,
      { kind: AnchorKind.ROLE, role: 'button', name: 'Search' },
      false,
      () => Promise.resolve(),
    );

    expect(result.ok, 'the step should survive the re-render').toBe(true);
    expect(queries, 'the locator must run again — the DOM is what changed').toBe(2);
    expect(acts).toBe(2);
  });
});
