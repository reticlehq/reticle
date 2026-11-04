/**
 * A plan whose steps declared nothing, over windows that settled, is `no-fault`, as one action is.
 *
 * `reticle_act { steps }` graded every undeclared plan `unknown`, also when each step reported a
 * settled frame and no channel flagged anything. A single `reticle_act_and_wait` with no `until`
 * over the same window is `no-fault`. `unknown` told the agent to look again with better coverage,
 * which cannot help: the next move is to declare a consequence. Since sequence verdicts count as
 * verifications, each such plan also counted as one more `unknown`.
 */
import { describe, expect, it } from 'vitest';
import {
  ReticleTool,
  SessionState,
  Verified,
  VerifiedReason,
  type CommandResult,
  type ReticleEvent,
} from '@reticlehq/core';
import { LastAct } from '@/portal/session/last-act.js';
import { BaselineStore } from '@/memory/project/baselines.js';
import { createNodeFileSystem } from '@/memory/project/fs/fs-port.js';
import { RecordingStore } from '@/language/flows/recording/tape/recordings.js';
import { FlowStore } from '@/language/flows/flows.js';
import { ProjectStore } from '@/memory/project/project-store.js';
import { AnnotationStore } from '@/language/flows/stores/annotation-store.js';
import { TOOLS } from './tools.js';

const ROOT = '/tmp/reticle-quiet-plan-test/.reticle';
const STEPS = [
  { ref: 'e1', action: 'click' },
  { ref: 'e2', action: 'click' },
];

async function runPlan(settled: boolean, lost = false): Promise<Record<string, unknown>> {
  const command = (name: string): Promise<CommandResult> =>
    Promise.resolve({
      kind: 'command_result',
      id: 'c',
      ok: true,
      result:
        'act' === name
          ? { ref: 'e1', action: 'click', dispatched: true, settled, settleReason: null }
          : {},
    });
  const noEvents: ReticleEvent[] = [];
  const session = {
    id: 'tab',
    url: 'http://localhost:5173/app',
    elapsed: () => 0,
    lastAct: new LastAct(),
    beginAction: () => 'a1',
    finishAction: () => undefined,
    command,
    queryEvents: () => Promise.resolve(noEvents),
    eventsSince: () => noEvents,
    bufferHealth: () => ({ total: 0, dropped: 0 }),
    lostSince: () => lost,
    blindSpots: () => ({}),
    health: () => ({ lastSeenMs: 0, throttled: false, focused: true }),
    throttled: () => false,
    getState: () => SessionState.ACTIVE,
    drainInbox: () => [],
    inboxSize: () => 0,
    onEvent: () => () => undefined,
  };
  const fs = createNodeFileSystem();
  const deps = {
    sessions: { resolve: () => session },
    baselines: new BaselineStore(),
    recordings: new RecordingStore(),
    flows: new FlowStore(fs, ROOT, { now: () => 0 }),
    project: new ProjectStore(fs, ROOT, { now: () => 0 }),
    annotations: new AnnotationStore(),
    fs,
    reticleRoot: ROOT,
    now: () => 0,
  };
  const tool = TOOLS.find((t) => t.name === ReticleTool.ACT_SEQUENCE);
  if (tool === undefined) {
    throw new Error('no reticle_act_sequence tool');
  }
  return (await tool.handler(deps as never, { steps: STEPS })) as Record<string, unknown>;
}

describe('an undeclared plan over settled windows', () => {
  it('is no-fault, the verdict one undeclared action gets', async () => {
    const r = await runPlan(true);
    expect(r['verified']).toBe(Verified.NO_FAULT);
    expect(r['verifiedReason']).toBe(VerifiedReason.NOTHING_DECLARED);
  });

  it('stays unknown when a step did not settle', async () => {
    const r = await runPlan(false);
    expect(r['verified']).toBe(Verified.UNKNOWN);
  });

  it('stays unknown when the capture lost events in the plan window', async () => {
    const r = await runPlan(true, true);
    expect(r['verified']).toBe(Verified.UNKNOWN);
  });
});
