import { describe, expect, it } from 'vitest';
import {
  AnchorKind,
  DriftReason,
  FLOW_FILE_VERSION,
  ReplayStatus,
  type FlowFile,
  type FlowReplayResult,
  type FlowStepResult,
} from '@reticlehq/core';
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

/**
 * `whereInSource` used to fall back to the step's page when it had no source, so a field whose name
 * promises a code location returned "/checkout" — rendered by the report writer as
 * "**Where:** `/checkout`". An agent cannot tell that apart from a file path, and a locator that is
 * sometimes a route is worse than no locator, because it cannot be trusted when it IS a path.
 *
 * A testid-anchored step can now carry source too: the act path captures provenance alongside the
 * anchor, so having a data-testid no longer costs the step its file:line.
 */
describe('whereInSource points at code or says nothing', () => {
  function failingStep(): FlowStepResult {
    return {
      step: 0,
      tool: ReticleTool.ACT,
      anchor: 'new-deploy',
      ok: false,
      page: '/deployments',
    };
  }

  it('does not pass a route off as a source location', () => {
    const result: FlowReplayResult = {
      name: 'verify',
      status: ReplayStatus.ERROR,
      steps: [failingStep()],
    };
    const f = flow({
      steps: [{ tool: ReticleTool.ACT, anchor: { kind: AnchorKind.TESTID, value: 'new-deploy' } }],
    });
    expect(buildDecision(result, f).whereInSource).toBeUndefined();
  });

  it('reports source recorded on a testid anchor', () => {
    const result: FlowReplayResult = {
      name: 'verify',
      status: ReplayStatus.ERROR,
      steps: [failingStep()],
    };
    const f = flow({
      steps: [
        {
          tool: ReticleTool.ACT,
          anchor: {
            kind: AnchorKind.TESTID,
            value: 'new-deploy',
            source: { file: 'src/components/Topbar.tsx', line: 31 },
          },
        },
      ],
    });
    expect(buildDecision(result, f).whereInSource).toBe('src/components/Topbar.tsx:31');
  });
});

/**
 * A flow that cannot fail must never be reported as passing.
 *
 * Measured: a flow saved as `{"steps": [], "intent": "navigate to a demo route"}` — which
 * `flow_save` had ALREADY graded assertion-free, `empty: true`, with a warning that it "claims to
 * verify a goal it does not assert" — replayed green and `flow_verify` answered
 * `{"status":"pass","total":1,"passed":1,"failed":0,"summary":"all 1 flow pass"}`.
 *
 * That is a permanent false green in the exact feature sold as the regression suite: the grader had
 * already said the flow was worthless and the verdict said everything was fine anyway.
 */
describe('buildSuiteVerdict — a flow that cannot fail is not a pass', () => {
  const okReplay = (name: string): FlowReplayResult => ({
    name,
    status: ReplayStatus.OK,
    steps: [],
  });
  const emptyFlow = (name: string): FlowFile =>
    ({ version: 1, name, steps: [], intent: 'navigate to a demo route' }) as unknown as FlowFile;
  const assertingFlow = (name: string): FlowFile =>
    ({
      version: 1,
      name,
      steps: [{ action: 'click', anchor: { testid: 'pay' }, expect: { signal: 'paid' } }],
    }) as unknown as FlowFile;

  it('does not count an empty flow as passed, and does not claim the suite passes', () => {
    const v = buildSuiteVerdict([{ replay: okReplay('empty'), flow: emptyFlow('empty') }]);
    expect(v.passed, 'nothing was verified').toBe(0);
    expect(v.status).not.toBe('pass');
    expect(v.summary).not.toContain('all 1 flow pass');
    expect(v.unverifiable?.[0]?.flow).toBe('empty');
  });

  it('names WHY it could not be verified, so the fix is obvious', () => {
    const v = buildSuiteVerdict([{ replay: okReplay('empty'), flow: emptyFlow('empty') }]);
    expect(v.unverifiable?.[0]?.reason ?? '').toMatch(/assert|step/i);
  });

  it('a real failure still outranks it — a broken flow is worse news than an empty one', () => {
    const v = buildSuiteVerdict([
      { replay: okReplay('empty'), flow: emptyFlow('empty') },
      {
        replay: { name: 'broken', status: ReplayStatus.ERROR, steps: [] },
        flow: assertingFlow('broken'),
      },
    ]);
    expect(v.status).toBe('fail');
    expect(v.failed).toBe(1);
  });

  it('a flow that asserts a consequence still passes normally', () => {
    const v = buildSuiteVerdict([{ replay: okReplay('real'), flow: assertingFlow('real') }]);
    expect(v.status).toBe('pass');
    expect(v.passed).toBe(1);
    expect(v.unverifiable ?? []).toEqual([]);
  });

  it('with no flow available to classify, behaviour is unchanged — never invent a warning', () => {
    const v = buildSuiteVerdict([{ replay: okReplay('unknown') }]);
    expect(v.status).toBe('pass');
    expect(v.passed).toBe(1);
  });
});

describe('buildDecision — the business outcome first, the mechanism underneath', () => {
  const CHECKIN = 'the trip badge reads "checked in" after the traveller checks in';

  function broken(name: string): FlowReplayResult {
    return {
      name,
      status: ReplayStatus.ERROR,
      steps: [
        {
          step: 2,
          tool: ReticleTool.ACT,
          anchor: 'send-checkin',
          ok: false,
          error: 'flow.success not satisfied',
        },
      ],
      error: { code: 'error', message: 'flow.success not satisfied' },
    };
  }

  it('a failing flow names the business outcome that is no longer true, before the step', () => {
    const d = buildDecision(broken('checkin'), flow({ intent: CHECKIN }));
    expect(d.summary).toContain(CHECKIN);
    expect(d.summary.indexOf(CHECKIN)).toBeLessThan(d.summary.indexOf('step 2'));
    expect(d.whatChanged).toBe('flow.success not satisfied');
  });

  it('a drifting flow names the intent too — a locator miss still breaks an outcome', () => {
    const result: FlowReplayResult = {
      name: 'checkin',
      status: ReplayStatus.DRIFT,
      steps: [
        {
          step: 0,
          tool: ReticleTool.ACT,
          anchor: 'send-checkin',
          ok: false,
          drift: {
            reasonKind: DriftReason.TESTID_NOT_FOUND,
            reason: 'testid "send-checkin" not found',
            anchor: 'send-checkin',
            nearest: 'send-check-in',
          },
        },
      ],
    };
    const d = buildDecision(result, flow({ intent: CHECKIN }));
    expect(d.summary).toContain(CHECKIN);
    expect(d.whatChanged).toBe('testid "send-checkin" not found');
  });

  it('quotes the ledger statement over the copy on the flow file, so an amendment wins', () => {
    const d = buildDecision(broken('checkin'), flow({ intent: CHECKIN }), 'the badge reads paid');
    expect(d.summary).toContain('the badge reads paid');
    expect(d.summary).not.toContain(CHECKIN);
  });

  it('a flow with no intent says so plainly rather than deriving one from its steps', () => {
    const d = buildDecision(broken('send-checkin'), flow());
    expect(d.summary).toContain('no intent declared');
    expect(d.summary).not.toContain('NO LONGER TRUE');
  });

  it('a passing flow with no intent says what its green does not cover', () => {
    const result: FlowReplayResult = {
      name: 'weak',
      status: ReplayStatus.OK,
      steps: [{ step: 0, tool: ReticleTool.ACT, anchor: 'btn', ok: true }],
    };
    const d = buildDecision(result, flow({ success: { signal: 'x:y' } }));
    expect(d.verdict).toBe('pass');
    expect(d.summary).toContain('no intent declared');
  });
});
