/**
 * A step that navigates the whole document must not make the run unreportable.
 *
 * From the field: `reticle_flow_replay` died with "session disconnected" on any flow whose start
 * navigation or step click loaded a new document. The flow physically completed — the session's own
 * journal shows click, navigation, 200 — but the command in flight was rejected by the handle that
 * had just died, the rejection propagated out of the tool, and a working app was reported as
 * unverifiable by way of a thrown error. A throw tells the caller nothing: not which step was
 * reached, not that a navigation was what ended the run, not whether anything was proved.
 *
 * So replay reports it instead. Never with a synthesised step result for the document that is gone —
 * that would be a fabricated pass — and never as a failure of the app, which nothing here observed.
 */
import { describe, expect, it } from 'vitest';
import {
  AnchorKind,
  FLOW_FILE_VERSION,
  FLOW_SIGNAL_TIMEOUT_MS,
  ReplayStatus,
  ReticleCommand,
  type CommandResult,
  type FlowFile,
  type ReticleEvent,
} from '@reticlehq/core';
import { waitForPredicate } from '@reticlehq/engine/question/predicate/predicate.js';
import { DocumentLostDuringReplay, replayFlow, type FlowReplaySession } from './flow-replay.js';
import { SESSION_DISCONNECTED_REASON } from '@/portal/session/facts/session-replaced.js';
import { lostDocumentResult, navigateAndAwait } from './flow-replay-run.js';
import type { SessionManager } from '@/portal/session/session-manager.js';
import type { Session } from '@/portal/session/session.js';

const found = (ref: string): CommandResult => ({
  kind: 'command_result',
  id: 'c',
  ok: true,
  result: { elements: [{ ref }] },
});

const acted: CommandResult = { kind: 'command_result', id: 'c', ok: true, result: {} };

/** A session whose Nth ACT is rejected the way a full-document navigation rejects one. */
class NavigatingSession implements FlowReplaySession {
  #acts = 0;
  constructor(private readonly dyingAct: number) {}
  command(name: string): Promise<CommandResult> {
    if (name !== ReticleCommand.ACT) return Promise.resolve(found('r1'));
    this.#acts += 1;
    // `SessionManager.remove` rejects every in-flight command with this when the socket closes.
    if (this.#acts === this.dyingAct) return Promise.reject(new Error(SESSION_DISCONNECTED_REASON));
    return Promise.resolve(acted);
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

const twoStepFlow: FlowFile = {
  version: FLOW_FILE_VERSION,
  name: 'open-invoice',
  createdAt: 0,
  steps: [
    { tool: 'reticle_act', anchor: { kind: AnchorKind.TESTID, value: 'row-1' }, action: 'click' },
    { tool: 'reticle_act', anchor: { kind: AnchorKind.TESTID, value: 'pay' }, action: 'click' },
  ],
};

describe('a replay whose step navigates the document', () => {
  it('reports the lost document instead of throwing a bare transport error', async () => {
    const session = new NavigatingSession(2);
    const thrown = await replayFlow(
      session,
      twoStepFlow,
      waitForPredicate,
      FLOW_SIGNAL_TIMEOUT_MS,
    ).catch((error: unknown) => error);
    expect(thrown, 'the caller must be able to tell this from any other failure').toBeInstanceOf(
      DocumentLostDuringReplay,
    );
  });

  it('carries the step it reached and the steps that did complete', async () => {
    const session = new NavigatingSession(2);
    const thrown: unknown = await replayFlow(
      session,
      twoStepFlow,
      waitForPredicate,
      FLOW_SIGNAL_TIMEOUT_MS,
    ).catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(DocumentLostDuringReplay);
    if (!(thrown instanceof DocumentLostDuringReplay)) return;
    expect(thrown.atStep, 'the second step is where the document went').toBe(1);
    expect(thrown.steps, 'only the step that actually answered').toHaveLength(1);
    expect(thrown.steps[0]?.ok).toBe(true);
  });

  it('never invents a result for the document that is gone', async () => {
    const session = new NavigatingSession(1);
    const thrown: unknown = await replayFlow(
      session,
      twoStepFlow,
      waitForPredicate,
      FLOW_SIGNAL_TIMEOUT_MS,
    ).catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(DocumentLostDuringReplay);
    if (!(thrown instanceof DocumentLostDuringReplay)) return;
    expect(thrown.steps, 'nothing answered, so nothing is reported').toHaveLength(0);
  });
});

/**
 * The other half of the same defect: the navigation replay dispatches ITSELF. `startPath` sends the
 * tab to the flow's start page, which closes the socket the NAVIGATE was sent on — so the command
 * rejects, and the arrival poll that was written to wait for the successor never ran. Replay then
 * carried on against a handle that could never answer again, and step 1 died the same way.
 */
describe('navigateAndAwait — the navigation that kills its own transport', () => {
  it('waits for the successor when the NAVIGATE is rejected by the document it unloaded', async () => {
    const dying = {
      id: 'old',
      url: 'http://localhost:3000/home',
      command: () => Promise.reject(new Error(SESSION_DISCONNECTED_REASON)),
    };
    const fresh = { id: 'fresh', url: 'http://localhost:3000/login', eventsSince: () => [] };
    let look = 0;
    const sessions = {
      resolve: () => {
        look += 1;
        if (look < 2) throw new Error('no connected session');
        return fresh as unknown as Session;
      },
    } as unknown as SessionManager;
    let t = 0;
    const clock = {
      now: () => t,
      sleep: () => {
        t += 100;
        return Promise.resolve();
      },
    };
    const arrived = await navigateAndAwait(
      sessions,
      dying,
      'http://localhost:3000/login',
      '/login',
      1_000,
      clock,
    );
    expect(arrived?.id, 'the page loaded — the rejection was the proof of it').toBe('fresh');
  });

  it('still gives up when no successor ever arrives', async () => {
    const dying = {
      id: 'old',
      url: 'http://localhost:3000/home',
      command: () => Promise.reject(new Error(SESSION_DISCONNECTED_REASON)),
    };
    const sessions = {
      resolve: () => {
        throw new Error('no connected session');
      },
    } as unknown as SessionManager;
    let t = 0;
    const clock = {
      now: () => t,
      sleep: () => {
        t += 100;
        return Promise.resolve();
      },
    };
    expect(
      await navigateAndAwait(sessions, dying, 'http://x/login', '/login', 300, clock),
    ).toBeUndefined();
  });
});

describe('the verdict a caller gets back when the document went', () => {
  const lost = new DocumentLostDuringReplay(
    [{ step: 0, ok: true, anchor: 'row-1' }],
    1,
    new Error(SESSION_DISCONNECTED_REASON),
  );

  it('is unverifiable, never a pass and never a failure of the app', () => {
    const result = lostDocumentResult('open-invoice', lost);
    expect(result.status).toBe(ReplayStatus.OK);
    expect(result.unverifiable?.reason, 'nothing here says the app is wrong').toBeDefined();
    expect(result.error, 'a thrown transport error told the caller nothing').toBeUndefined();
  });

  it('names the step it reached and keeps the steps that did answer', () => {
    const result = lostDocumentResult('open-invoice', lost);
    expect(result.steps).toHaveLength(1);
    expect(result.unverifiable?.reason).toContain('step 1');
  });
});
