/**
 * Sequence steps must resolve `target` the same way `reticle_act` does.
 *
 * A step `{ target: { label: "Email" }, action: "fill" }` used to dispatch with no ref. The
 * browser then threw `ref '' no longer resolves to an element`, which reads as a stale-ref
 * problem rather than an unsupported locator — and the caller went looking for a re-render.
 */
import { describe, expect, it } from 'vitest';
import { LastAct } from '../../portal/session/last-act.js';
import { SessionState } from '@reticlehq/core';
import type { CommandResult, ReticleEvent } from '@reticlehq/core';
import { TOOLS, type ToolDeps } from './tools.js';
import { asString } from '@reticlehq/core';
import { ReticleTool } from '@reticlehq/core';
import { BaselineStore } from '../../memory/project/baselines.js';
import { createNodeFileSystem } from '../../memory/project/fs/fs-port.js';
import { RecordingStore } from '../../language/flows/recording/tape/recordings.js';
import { FlowStore } from '../../language/flows/flows.js';
import { ProjectStore } from '../../memory/project/project-store.js';
import { AnnotationStore } from '../../language/flows/stores/annotation-store.js';
import type { Session } from '../../portal/session/session.js';
import type { SessionManager } from '../../portal/session/session-manager.js';

interface ActCall {
  name: string;
  args: Record<string, unknown>;
}

function sessionThatResolvesTargets(matches: Record<string, { ref: string }[]>): {
  session: Session;
  calls: ActCall[];
} {
  const calls: ActCall[] = [];
  const command = (name: string, args: Record<string, unknown>): Promise<CommandResult> => {
    calls.push({ name, args });
    if ('query' === name) {
      const key = asString(args['value']) ?? '';
      return Promise.resolve({
        kind: 'command_result',
        id: 'c',
        ok: true,
        result: { elements: matches[key] ?? [] },
      });
    }
    if ('act' === name) {
      return Promise.resolve({
        kind: 'command_result',
        id: 'c',
        ok: true,
        result: {
          ref: args['ref'],
          action: args['action'],
          dispatched: true,
          settled: true,
          settleReason: null,
        },
      });
    }
    return Promise.resolve({ kind: 'command_result', id: 'c', ok: true, result: {} });
  };
  return { session: fakeSessionFrom(command), calls };
}

/** The same stub, built from any command implementation, so a test can script the QUERY answers. */
function fakeSessionFrom(
  command: (name: string, args: Record<string, unknown>) => Promise<CommandResult>,
): Session {
  const noEvents: ReticleEvent[] = [];
  const stub: Partial<Session> = {
    id: 'demo',
    url: 'http://localhost:5173/app',
    elapsed: () => 1000,
    lastAct: new LastAct(),
    beginAction: () => 'a1',
    finishAction: () => undefined,
    command,
    queryEvents: () => Promise.resolve(noEvents),
    eventsSince: () => noEvents,
    bufferHealth: () => ({ total: 0, dropped: 0 }),
    lostSince: () => false,
    blindSpots: () => ({}),
    health: () => ({ lastSeenMs: 0, throttled: false, focused: true }),
    throttled: () => false,
    getState: () => SessionState.ACTIVE,
    drainInbox: () => [],
    inboxSize: () => 0,
  };
  return stub as Session;
}

function fakeDeps(session: Session): ToolDeps {
  const sessions: Partial<SessionManager> = { resolve: () => session };
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
  const found = TOOLS.find((t) => t.name === name);
  if (found === undefined) throw new Error(`no ${name} tool`);
  return found;
}

interface SequenceResult {
  dispatched: boolean;
  completed: number;
  stalled_at?: number;
  steps?: { ref?: string; action?: string; dispatched?: boolean | null; error?: string }[];
}

describe('act_sequence steps that name a target', () => {
  it('resolves target to a ref before dispatch, instead of sending an empty ref', async () => {
    const { session, calls } = sessionThatResolvesTargets({
      Email: [{ ref: 'e12' }],
    });

    const result = (await tool(ReticleTool.ACT_SEQUENCE).handler(fakeDeps(session), {
      steps: [{ target: { label: 'Email' }, action: 'fill', args: { value: 'a@b.com' } }],
    })) as SequenceResult;

    expect(result.completed).toBe(1);
    expect(result.dispatched).toBe(true);
    const act = calls.find((c) => 'act' === c.name);
    expect(act?.args['ref'], 'must dispatch the resolved ref, not an empty one').toBe('e12');
    expect(act?.args['ref']).not.toBe('');
    expect(act?.args).not.toHaveProperty('target');
  });

  it('does not blame a stale ref when the step used target', async () => {
    const { session, calls } = sessionThatResolvesTargets({
      Email: [{ ref: 'e12' }],
    });

    await tool(ReticleTool.ACT_SEQUENCE).handler(fakeDeps(session), {
      steps: [{ target: { label: 'Email' }, action: 'fill' }],
    });

    const act = calls.find((c) => 'act' === c.name);
    expect(asString(act?.args['ref'])).toBe('e12');
  });

  it('refuses a missed target as a locator miss, not a stale empty ref', async () => {
    const { session, calls } = sessionThatResolvesTargets({});

    /*
     * `timeout_ms: 0` because a named target is now WAITED for, not resolved in one shot: the
     * element a later step acts on often does not exist when a batch is submitted, and refusing
     * instantly is what made agents abandon batching and pay a model turn per step. Zero is the
     * caller saying "do not wait", which is exactly the question this test is asking — does a
     * genuinely absent element read as a locator miss rather than a stale ref. The waiting path has
     * its own test below.
     */
    const result = (await tool(ReticleTool.ACT_SEQUENCE).handler(fakeDeps(session), {
      steps: [{ target: { label: 'Email' }, action: 'fill' }],
      timeout_ms: 0,
    })) as SequenceResult;

    expect(result.dispatched).toBe(false);
    expect(result.stalled_at).toBe(0);
    expect(result.steps?.[0]?.error).toMatch(/target matched no element/);
    expect(result.steps?.[0]?.error).not.toMatch(/no longer resolves/);
    expect(
      calls.some((c) => 'act' === c.name),
      'must not dispatch against a missing locator',
    ).toBe(false);
  });

  it('WAITS for a target that does not exist yet, then acts on it', async () => {
    /*
     * The case that makes batching usable: step 1 opens a modal and step 2 acts on something inside
     * it. That element cannot be named by ref up front and does not exist at submit time, so a
     * single-shot resolve fails the whole batch and the agent goes back to snapshot/act/snapshot.
     */
    let looks = 0;
    const calls: ActCall[] = [];
    const command = (name: string, args: Record<string, unknown>): Promise<CommandResult> => {
      calls.push({ name, args });
      if ('query' === name) {
        looks += 1;
        // Absent for the first two looks, then rendered — a modal finishing its animation.
        const elements = looks > 2 ? [{ ref: 'e99' }] : [];
        return Promise.resolve({ kind: 'command_result', id: 'c', ok: true, result: { elements } });
      }
      return Promise.resolve({ kind: 'command_result', id: 'c', ok: true, result: {} });
    };
    const session = fakeSessionFrom(command);

    const result = (await tool(ReticleTool.ACT_SEQUENCE).handler(fakeDeps(session), {
      steps: [{ target: { label: 'Confirm' }, action: 'click' }],
      timeout_ms: 4000,
    })) as SequenceResult;

    expect(looks, 'must look more than once').toBeGreaterThan(1);
    expect(result.steps?.[0]?.error, 'the late element is found, not refused').toBeUndefined();
    expect(asString(calls.find((c) => 'act' === c.name)?.args['ref'])).toBe('e99');
  });
});
