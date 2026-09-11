import { describe, expect, it } from 'vitest';
import {
  ActionType,
  AnchorKind,
  EventType,
  FLOW_FILE_VERSION,
  InstrumentationGapKind,
  type CommandResult,
  type FlowFile,
  type InstrumentationGap,
  type ReticleEvent,
} from '@reticlehq/core';
import { createMemoryFs } from '../project/memory-fs.js';
import { FlowStore, type FlowAnnotations } from './flows.js';
import { ProjectStore } from '../project/project-store.js';
import { BaselineStore } from '../project/baselines.js';
import { AnnotationStore } from './annotation-store.js';
import { RecordingStore, type CompiledProgram } from './recordings.js';
import { FLOW_TOOLS } from './flow-tools.js';
import { ReticleTool } from '../tools/tool-names.js';
import { flowIntentId } from './flow-intent.js';
import type { ToolDeps } from '../tools/tools.js';
import type { Session, SessionManager } from '../session/session.js';

const ROOT = '/repo/.reticle';
const NOW = 1_000;
const GOAL = 'the trip badge reads "checked in" after the traveller checks in';
/** The words a derived intent would be built out of: flow name, step testid, assertion. */
const FLOW_NAME = 'checkin';
const STEP_TESTID = 'send-checkin';
const SIGNAL_NAME = 'checkin:confirmed';

interface SaveResult {
  ok: boolean;
  value?: { name: string; intentGap?: InstrumentationGap };
}

function harness(): { flows: FlowStore; written: Map<string, string> } {
  const { fs, written } = createMemoryFs();
  return { flows: new FlowStore(fs, ROOT, { now: () => NOW }), written };
}

function program(name: string): CompiledProgram {
  return {
    name,
    version: 1,
    steps: [
      {
        tool: ReticleTool.ACT,
        stable: true,
        args: { by: 'testid', value: STEP_TESTID, action: ActionType.CLICK, args: {} },
        expect: { signal: SIGNAL_NAME },
      },
    ],
  };
}

function annotations(partial: Partial<FlowAnnotations>): FlowAnnotations {
  return { stepExpect: new Map(), dynamic: [], ...partial };
}

function flowFile(name: string, extra?: Partial<FlowFile>): FlowFile {
  return {
    version: FLOW_FILE_VERSION,
    name,
    createdAt: NOW,
    steps: [
      {
        tool: ReticleTool.ACT,
        anchor: { kind: AnchorKind.TESTID, value: STEP_TESTID },
        action: ActionType.CLICK,
        args: {},
        expect: { signal: SIGNAL_NAME },
      },
    ],
    ...extra,
  };
}

function gapOf(result: unknown): InstrumentationGap | undefined {
  return (result as SaveResult).value?.intentGap;
}

/** Every word an intent could be wrongly derived FROM. */
function mentionsAnythingDerived(gap: InstrumentationGap): boolean {
  const text = `${gap.missing} ${gap.cost} ${gap.fix}`;
  return [FLOW_NAME, STEP_TESTID, SIGNAL_NAME].some((word) => text.includes(word));
}

describe('a flow saved with no intent says so', () => {
  it('reports the missing intent, what it costs and the one thing that fixes it', async () => {
    const { flows } = harness();
    const gap = gapOf(await flows.save(program(FLOW_NAME)));

    expect(gap?.kind).toBe(InstrumentationGapKind.NO_FLOW_INTENT);
    expect(gap?.missing).toBeTruthy();
    expect(gap?.cost).toBeTruthy();
    expect(gap?.fix).toBeTruthy();
  });

  it('stays silent when the flow declares its goal in prose', async () => {
    const { flows } = harness();
    const saved = await flows.save(program(FLOW_NAME), annotations({ intent: GOAL }));

    expect(gapOf(saved)).toBeUndefined();
  });

  it('stays silent when the flow points at an intent declared earlier', async () => {
    const { flows } = harness();
    const saved = await flows.saveFlow(flowFile(FLOW_NAME, { intentId: flowIntentId('other') }));

    expect(gapOf(saved)).toBeUndefined();
  });

  it('never derives a goal from the flow name, a step or an assertion', async () => {
    const { flows } = harness();
    const gap = gapOf(await flows.save(program(FLOW_NAME)));

    expect(gap === undefined ? true : mentionsAnythingDerived(gap)).toBe(false);
  });

  it('does not block the save, and writes the same bytes it wrote before the nudge existed', async () => {
    const { flows, written } = harness();
    const saved = await flows.save(program(FLOW_NAME));

    expect((saved as SaveResult).ok).toBe(true);
    const [file] = [...written.values()];
    expect(file).toBe(
      `${JSON.stringify(
        {
          version: FLOW_FILE_VERSION,
          name: FLOW_NAME,
          createdAt: NOW,
          steps: [
            {
              tool: ReticleTool.ACT,
              anchor: { kind: AnchorKind.TESTID, value: STEP_TESTID },
              args: {},
              action: ActionType.CLICK,
              expect: { signal: SIGNAL_NAME },
            },
          ],
        },
        null,
        2,
      )}\n`,
    );
  });

  it('reports the same gap whichever save path the flow arrived through', async () => {
    const compiled = harness();
    const recorded = harness();

    expect(gapOf(await compiled.flows.save(program(FLOW_NAME)))).toEqual(
      gapOf(await recorded.flows.saveFlow(flowFile(FLOW_NAME))),
    );
  });
});

function fakeDeps(recorded?: FlowFile): ToolDeps {
  const { fs } = createMemoryFs();
  const command = (): Promise<CommandResult> =>
    Promise.resolve({ kind: 'command_result', id: 'c', ok: true, result: {} });
  const events: ReticleEvent[] =
    recorded === undefined
      ? []
      : [
          {
            t: 1,
            type: EventType.FLOW_RECORDED,
            sessionId: 'demo',
            data: { name: recorded.name, flow: recorded },
          },
        ];
  const session: Partial<Session> = { id: 'demo', command, eventsSince: () => events };
  const sessions: Partial<SessionManager> = { resolve: () => session as Session };
  return {
    sessions: sessions as SessionManager,
    baselines: new BaselineStore(),
    recordings: new RecordingStore(),
    flows: new FlowStore(fs, ROOT, { now: () => NOW }),
    project: new ProjectStore(fs, ROOT, { now: () => NOW }),
    annotations: new AnnotationStore(),
    fs,
    reticleRoot: ROOT,
    now: () => NOW,
  };
}

function flowTool(name: string): (typeof FLOW_TOOLS)[number] {
  const found = FLOW_TOOLS.find((t) => t.name === name);
  if (found === undefined) throw new Error(`no tool ${name}`);
  return found;
}

describe('an author can answer the nudge in the same call', () => {
  it('reticle_flow_save takes an intent argument and goes quiet', async () => {
    const deps = fakeDeps();
    deps.recordings.saveCompiled(program(FLOW_NAME));
    const res = (await flowTool(ReticleTool.FLOW_SAVE).handler(deps, {
      flowName: FLOW_NAME,
      intent: GOAL,
    })) as { intentGap?: InstrumentationGap };

    expect(res.intentGap).toBeUndefined();
    const loaded = await deps.flows.load(FLOW_NAME);
    expect(loaded.ok && loaded.value.intent).toBe(GOAL);
  });

  it('reticle_flow_save reports the gap when no intent is given', async () => {
    const deps = fakeDeps();
    deps.recordings.saveCompiled(program(FLOW_NAME));
    const res = (await flowTool(ReticleTool.FLOW_SAVE).handler(deps, {
      flowName: FLOW_NAME,
    })) as { intentGap?: InstrumentationGap };

    expect(res.intentGap?.kind).toBe(InstrumentationGapKind.NO_FLOW_INTENT);
  });

  it('reticle_flow_save_recorded takes an intent argument and goes quiet', async () => {
    const deps = fakeDeps(flowFile(FLOW_NAME));
    const res = (await flowTool(ReticleTool.FLOW_SAVE_RECORDED).handler(deps, {
      intent: GOAL,
    })) as { intentGap?: InstrumentationGap };

    expect(res.intentGap).toBeUndefined();
    const loaded = await deps.flows.load(FLOW_NAME);
    expect(loaded.ok && loaded.value.intent).toBe(GOAL);
  });

  it('reticle_flow_save_recorded reports the gap when no intent is given', async () => {
    const deps = fakeDeps(flowFile(FLOW_NAME));
    const res = (await flowTool(ReticleTool.FLOW_SAVE_RECORDED).handler(deps, {})) as {
      intentGap?: InstrumentationGap;
    };

    expect(res.intentGap?.kind).toBe(InstrumentationGapKind.NO_FLOW_INTENT);
  });
});
