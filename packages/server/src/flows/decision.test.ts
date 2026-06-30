import { describe, expect, it } from 'vitest';
import {
  AnchorKind,
  DriftReason,
  FLOW_FILE_VERSION,
  ReplayStatus,
  type FlowFile,
  type FlowReplayResult,
} from '@reticle/protocol';
import { ReticleTool } from '../tools/tool-names.js';
import { buildDecision, buildSuiteVerdict } from './decision.js';

function flow(partial: Partial<FlowFile> = {}): FlowFile {
  return { version: FLOW_FILE_VERSION, name: 'f', createdAt: 0, steps: [], ...partial };
}

describe('buildDecision — the autonomy envelope', () => {
  it('pass with a consequence assertion → verdict pass, no further action', () => {
    const result: FlowReplayResult = {
      name: 'ship-deploy',
      status: ReplayStatus.OK,
      steps: [{ step: 0, tool: ReticleTool.ACT, anchor: 'new-deploy', ok: true }],
    };
    const d = buildDecision(result, flow({ success: { signal: 'deploy:shipped' } }));
    expect(d.verdict).toBe('pass');
    expect(d.nextAction).toContain('none');
  });

  it('pass with an intent + consequence → summary says the intent was verified', () => {
    const result: FlowReplayResult = {
      name: 'ship-deploy',
      status: ReplayStatus.OK,
      steps: [{ step: 0, tool: ReticleTool.ACT, anchor: 'new-deploy', ok: true }],
    };
    const d = buildDecision(
      result,
      flow({ intent: 'ship a deploy', success: { signal: 'deploy:shipped' } }),
    );
    expect(d.summary).toContain('ship a deploy');
    expect(d.summary).toContain('verified');
  });

  it('pass with NO assertion → next action is to add a consequence oracle', () => {
    const result: FlowReplayResult = {
      name: 'weak',
      status: ReplayStatus.OK,
      steps: [{ step: 0, tool: ReticleTool.ACT, anchor: 'btn', ok: true }],
    };
    const d = buildDecision(result, flow());
    expect(d.verdict).toBe('pass');
    expect(d.nextAction).toContain('consequence assertion');
  });

  it('drift → points at the source file:line and suggests the nearest rebind', () => {
    const result: FlowReplayResult = {
      name: 'verify',
      status: ReplayStatus.DRIFT,
      steps: [
        {
          step: 0,
          tool: ReticleTool.ACT,
          anchor: 'NewDeployButton@Deployments.tsx:107',
          ok: false,
          drift: {
            reasonKind: DriftReason.COMPONENT_NOT_FOUND,
            reason: 'component anchor not found',
            anchor: 'NewDeployButton@Deployments.tsx:107',
            nearest: 'new-deploy',
          },
        },
      ],
    };
    const f = flow({
      steps: [
        {
          tool: ReticleTool.ACT,
          anchor: {
            kind: AnchorKind.COMPONENT,
            component: 'NewDeployButton',
            source: { file: 'src/Deployments.tsx', line: 107 },
          },
        },
      ],
    });
    const d = buildDecision(result, f);
    expect(d.verdict).toBe('drift');
    expect(d.whatChanged).toBe('component anchor not found');
    expect(d.whereInSource).toBe('src/Deployments.tsx:107');
    expect(d.suggestedFix).toContain('new-deploy');
    expect(d.nextAction).toContain('new-deploy');
  });

  it('drift with an ambiguous nearest → does not suggest a blind rebind', () => {
    const result: FlowReplayResult = {
      name: 'verify',
      status: ReplayStatus.DRIFT,
      steps: [
        {
          step: 0,
          tool: ReticleTool.ACT,
          anchor: 'submit',
          ok: false,
          drift: {
            reasonKind: DriftReason.TESTID_NOT_FOUND,
            reason: 'testid "submit" not found',
            anchor: 'submit',
            nearest: 'submit-a',
            ambiguous: true,
          },
        },
      ],
    };
    const d = buildDecision(result, flow());
    expect(d.suggestedFix).toContain('ambiguous');
  });

  it('error on the success oracle → verdict fail, check the handler (not the locator)', () => {
    const result: FlowReplayResult = {
      name: 'verify-500',
      status: ReplayStatus.ERROR,
      steps: [
        { step: 0, tool: ReticleTool.ACT, anchor: 'fault-500', ok: true },
        {
          step: 1,
          tool: 'success',
          anchor: 'fault:injected',
          ok: false,
          error: 'flow.success not satisfied',
        },
      ],
      error: { code: 'error', message: 'flow.success not satisfied' },
    };
    const d = buildDecision(result, flow());
    expect(d.verdict).toBe('fail');
    expect(d.whatChanged).toBe('flow.success not satisfied');
    expect(d.nextAction).toContain('handler');
  });
});

describe('buildSuiteVerdict — the autonomous regression check', () => {
  const ok = (name: string): FlowReplayResult => ({
    name,
    status: ReplayStatus.OK,
    steps: [{ step: 0, tool: ReticleTool.ACT, anchor: 'x', ok: true }],
  });
  const drifted = (name: string): FlowReplayResult => ({
    name,
    status: ReplayStatus.DRIFT,
    steps: [
      {
        step: 0,
        tool: ReticleTool.ACT,
        anchor: 'gone',
        ok: false,
        drift: {
          reasonKind: DriftReason.TESTID_NOT_FOUND,
          reason: 'testid "gone" not found',
          anchor: 'gone',
          nearest: 'here',
        },
      },
    ],
  });

  it('all flows pass → status pass, no failures', () => {
    const v = buildSuiteVerdict([{ replay: ok('a') }, { replay: ok('b') }]);
    expect(v.status).toBe('pass');
    expect(v.total).toBe(2);
    expect(v.passed).toBe(2);
    expect(v.failures).toEqual([]);
    expect(v.summary).toContain('all 2 flows pass');
  });

  it('a failing flow → status fail, only the failure carries the actionable detail', () => {
    const v = buildSuiteVerdict([
      { replay: ok('a') },
      { replay: drifted('b') },
      { replay: ok('c') },
    ]);
    expect(v.status).toBe('fail');
    expect(v.passed).toBe(2);
    expect(v.failed).toBe(1);
    expect(v.failures).toHaveLength(1);
    expect(v.failures[0]?.flow).toBe('b');
    expect(v.failures[0]?.verdict).toBe('drift');
    expect(v.failures[0]?.nextAction).toContain('here'); // the rebind suggestion
    expect(v.summary).toContain('2/3 flows pass');
    expect(v.summary).toContain('b');
  });
});
