/**
 * A flow step whose predecessor re-rendered the page must not lose the replay (#602).
 *
 * The reported failure: a saved `fill` then `click` flow fails on replay with
 * `ref 'eNNNN' no longer resolves to an element`, a DIFFERENT ref number on every attempt.
 * `reticle_flow_heal` returns `unhealable`, and it is right to — the locator is correct, only the
 * timing is wrong, so there is nothing to heal.
 *
 * Replay already re-resolves every anchor per step. The race is INSIDE one step: the fill triggers a
 * search re-render between resolving the ref and dispatching against it. The retry therefore has to
 * re-resolve, not merely re-send — dispatching the same stale ref twice would fail twice.
 *
 * `act_sequence` already solved this shape; the rule copied here is its rule exactly. Retry only for
 * staleness, after the grace period the app already gets, so a genuinely gone element fails again
 * immediately and no other failure ever re-runs an action.
 */
import { describe, expect, it } from 'vitest';
import {
  asRef,
  ActionType,
  AnchorKind,
  DriftReason,
  FLOW_FILE_VERSION,
  ReticleCommand,
  type CommandResult,
  type ElementDescriptor,
  type FlowFile,
  type ReticleEvent,
} from '@reticlehq/core';
import { replayFlow, type FlowReplaySession } from './flow-replay.js';
import { asString } from '../tools/tools-helpers.js';

const STALE = "ref 'e1' no longer resolves to an element";

function element(ref: string): ElementDescriptor {
  return { ref: asRef(ref), role: 'button', name: 'Search', states: [], visible: true };
}

/**
 * A page that re-renders once: the first resolve hands out `e1`, every later one hands out `e2`,
 * and an ACT against `e1` after the re-render reports the daemon's stale-ref wording.
 */
class ReRenderingSession implements FlowReplaySession {
  readonly acts: { ref: string; action: string }[] = [];
  resolves = 0;
  constructor(
    /** Refs handed out in order; the last one repeats once exhausted. */
    private readonly refs: readonly string[] = ['e1', 'e2'],
    /** Refs the browser refuses as stale. */
    private readonly staleRefs: ReadonlySet<string> = new Set(['e1']),
  ) {}

  command(name: string, args: Record<string, unknown> = {}): Promise<CommandResult> {
    if (name === ReticleCommand.QUERY) {
      const ref = this.refs[Math.min(this.resolves, this.refs.length - 1)];
      this.resolves += 1;
      return Promise.resolve({
        kind: 'command_result',
        id: 'q',
        ok: true,
        result: { elements: ref === undefined ? [] : [element(ref)] },
      });
    }
    if (name === ReticleCommand.ACT) {
      const ref = asString(args['ref']) ?? '';
      this.acts.push({ ref, action: asString(args['action']) ?? '' });
      const stale = this.staleRefs.has(ref);
      return Promise.resolve({
        kind: 'command_result',
        id: 'a',
        ok: !stale,
        result: {},
        ...(stale ? { error: STALE } : {}),
      } as CommandResult);
    }
    return Promise.resolve({ kind: 'command_result', id: 'x', ok: true, result: {} });
  }
  eventsSince(): ReticleEvent[] {
    return [];
  }
  onEvent(): () => void {
    return () => undefined;
  }
  elapsed(): number {
    return 0;
  }
}

function flow(): FlowFile {
  return {
    version: FLOW_FILE_VERSION,
    name: 'search',
    steps: [
      {
        tool: 'reticle_act',
        anchor: { kind: AnchorKind.TESTID, value: 'search-submit' },
        action: ActionType.CLICK,
      },
    ],
  } as unknown as FlowFile;
}

const noSleep = (): Promise<void> => Promise.resolve();

async function replay(session: FlowReplaySession) {
  return replayFlow(session, flow(), () => Promise.resolve({ pass: true }), 0, false, noSleep);
}

describe('a ref that went stale mid-step is retried against a fresh one', () => {
  it('completes the step instead of failing the replay', async () => {
    const session = new ReRenderingSession();
    const [result] = await replay(session);
    expect(result?.ok, 'the locator was right; only the timing was wrong').toBe(true);
    expect(result?.drift, 'this is not drift — nothing to heal').toBeUndefined();
  });

  it('re-resolves before retrying, rather than re-sending the same dead ref', async () => {
    // The property the fix rests on. Dispatching `e1` twice would fail twice, and a retry that
    // only re-sends would look like it worked in a test that stubbed the second ACT to succeed.
    const session = new ReRenderingSession();
    await replay(session);
    expect(session.acts.map((a) => a.ref)).toEqual(['e1', 'e2']);
    expect(session.resolves, 'resolved once, then again for the retry').toBe(2);
  });

  it('does not retry an action that failed for any other reason', async () => {
    // A tool that quietly re-runs actions turns one click into two, which is worse than the failure
    // it was papering over.
    class OtherFailure extends ReRenderingSession {
      override command(name: string, args: Record<string, unknown> = {}): Promise<CommandResult> {
        if (name === ReticleCommand.ACT) {
          return Promise.resolve({
            kind: 'command_result',
            id: 'a',
            ok: false,
            error: 'element is disabled',
          } as CommandResult);
        }
        return super.command(name, args);
      }
    }
    const session = new OtherFailure();
    const [result] = await replay(session);
    expect(result?.ok).toBe(false);
    expect(result?.error).toContain('disabled');
  });

  it('reports drift, not a stale ref, when the element is genuinely gone', async () => {
    // The second resolve proves it. Reporting the stale-ref error here would send the reader after a
    // re-render that did not happen.
    // After the first resolve the page has nothing left to hand back.
    const gone = new (class extends ReRenderingSession {
      override command(name: string, args: Record<string, unknown> = {}): Promise<CommandResult> {
        if (name === ReticleCommand.QUERY && this.resolves > 0) {
          this.resolves += 1;
          return Promise.resolve({
            kind: 'command_result',
            id: 'q',
            ok: true,
            result: { elements: [], hint: { presentTestids: ['search-input'] } },
          });
        }
        return super.command(name, args);
      }
    })(['e1'], new Set(['e1']));
    const [result] = await replay(gone);
    expect(result?.ok).toBe(false);
    expect(result?.drift?.reasonKind).toBe(DriftReason.TESTID_NOT_FOUND);
  });

  it('leaves a clean step at exactly one dispatch', async () => {
    const session = new ReRenderingSession(['e2'], new Set());
    const [result] = await replay(session);
    expect(result?.ok).toBe(true);
    expect(session.acts).toHaveLength(1);
  });
});
