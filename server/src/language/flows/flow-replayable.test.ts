/**
 * Whether a saved flow can replay at all, decided when it is saved.
 *
 * Shipped defect: of 34 flows saved over one night, 5 replayed green. The rest started with no
 * page to open, anchored on a test id six buttons share, asserted a live count ("Open 336") that
 * the next run cannot see again, or WROTE real data each time they replayed (a PATCH that marked
 * an issue fixed again). None of that was said when the flow was saved, so each one was found
 * by a replay that drifted.
 */
import { describe, expect, it } from 'vitest';
import {
  EventType,
  FLOW_FILE_VERSION,
  ReplayStatus,
  type FlowFile,
  type FlowStep,
} from '@reticlehq/core';
import { recordedStepToFlowStep } from './flows.js';
import { compileActStep, wroteIn } from './replay.js';
import { buildSuiteVerdict } from './decision.js';
import { writingFlows } from './suite-selection.js';
import { readyForReplay, replayability, Replayable } from './flow-replayable.js';

const click = (value: string, expect?: FlowStep['expect']): FlowStep => ({
  tool: 'reticle_act',
  anchor: { kind: 'testid', value },
  action: 'click',
  args: {},
  ...(expect === undefined ? {} : { expect }),
});

const flowOf = (steps: FlowStep[], extra: Partial<FlowFile> = {}): FlowFile => ({
  version: FLOW_FILE_VERSION,
  name: 'f',
  createdAt: 0,
  startPath: '/issues',
  steps,
  ...extra,
});

describe('a flow made ready to replay at save', () => {
  it('keeps the words of a live count and lets the number change', () => {
    const ready = readyForReplay(flowOf([click('tab', { kind: 'text', contains: 'Open 336' })]));
    expect(ready.steps[0]?.expect).toEqual({
      kind: 'text',
      contains: 'Open',
      satisfies: { property: 'matchesPattern', pattern: 'Open \\d[\\d,.]*' },
    });
    expect(replayability(ready).status).toBe(Replayable.YES);
  });

  it('keeps a money number exact and says the flow is bound to the data', () => {
    const flow = flowOf([click('send', { kind: 'text', contains: '8 of 10 credits left' })], {
      intent: 'a check takes its price off the credits',
    });
    const ready = readyForReplay(flow);
    expect(ready.steps[0]?.expect).toEqual({ kind: 'text', contains: '8 of 10 credits left' });
    const report = replayability(ready);
    expect(report.status).toBe(Replayable.DATA_BOUND);
    expect(report.why?.join(' ')).toMatch(/step 1 .*8 of 10 credits left/);
  });

  it('says a bare number or a count in an accessible name is bound to the data', () => {
    const ready = readyForReplay(
      flowOf([
        click('total', { kind: 'text', contains: '365.75' }),
        click('node', {
          kind: 'element',
          query: { role: 'button', name: '/runs, 59 flows' },
        }),
      ]),
    );
    const report = replayability(ready);
    expect(report.status).toBe(Replayable.DATA_BOUND);
    expect(report.why).toHaveLength(2);
  });

  it('marks a step whose expect saw a write request, inside a sequence too', () => {
    const sequence: FlowStep = {
      tool: 'reticle_act_sequence',
      anchor: { kind: 'testid', value: 'issue-resolve' },
      steps: [
        click('issue-resolve', {
          kind: 'allOf',
          predicates: [
            { kind: 'net', method: 'PATCH', urlContains: '/v1/issues/1af0', status: 200 },
          ],
        }),
      ],
    };
    const ready = readyForReplay(flowOf([sequence]));
    expect(ready.steps[0]?.writes).toBe(true);
    expect(ready.steps[0]?.steps?.[0]?.writes).toBe(true);
    const report = replayability(ready);
    expect(report.writes).toBe(true);
    expect(report.why?.join(' ')).toMatch(/step 1\.1 sends PATCH \/v1\/issues\/1af0/);
  });

  it('says why a flow cannot replay: no starting page, no anchor, a shared test id', () => {
    const report = replayability(
      flowOf(
        [
          { tool: 'reticle_act', anchor: { kind: 'role', role: 'unresolved' }, degraded: true },
          { ...click('runs-result'), anchor: { kind: 'testid', value: 'runs-result', of: 6 } },
        ],
        { startPath: undefined },
      ),
    );
    expect(report.status).toBe(Replayable.NO);
    expect(report.why).toEqual([
      'no starting page was recorded, so a replay starts wherever the tab is',
      'step 1 has no anchor a replay can find',
      "step 2 anchors on test id 'runs-result', which 6 elements share",
    ]);
  });

  it('reports a clean flow as replayable and says nothing more', () => {
    const report = replayability(
      readyForReplay(flowOf([click('save', { kind: 'route', pathname: '/done' })])),
    );
    expect(report).toEqual({ status: Replayable.YES });
  });
});

describe('the suite verdict reports each flow that cannot replay as saved', () => {
  it('names the flow, its status and why, and says how many in the summary', () => {
    const replay = (name: string) => ({
      name,
      status: ReplayStatus.DRIFT,
      steps: [],
    });
    const verdict = buildSuiteVerdict([
      { replay: replay('clean'), flow: flowOf([click('save', { kind: 'route', pathname: '/x' })]) },
      { replay: replay('counted'), flow: flowOf([click('t', { kind: 'text', contains: '365' })]) },
    ]);
    expect(verdict.replayability).toEqual([
      { flow: 'counted', status: Replayable.DATA_BOUND, why: ["step 1 expects '365', live data"] },
    ]);
    expect(verdict.summary).toMatch(/1 of 2 flows are not replayable as saved \(counted\)/);
  });
});

describe('a certify run that must not change data', () => {
  it('holds back a flow saved before steps were marked, from the write its expect names', () => {
    const marks = flowOf([
      click('resolve', { kind: 'net', method: 'patch', urlContains: '/v1/issues/1' }),
    ]);
    const reads = flowOf([
      click('open', { kind: 'net', method: 'GET', urlContains: '/v1/issues' }),
    ]);
    expect(
      writingFlows([
        { ...marks, name: 'marks' },
        { ...reads, name: 'reads' },
      ]),
    ).toEqual(['marks']);
  });
});

describe('a step that sent a write request while it was recorded', () => {
  const request = (method: string, url: string) => ({
    type: EventType.NET_REQUEST,
    t: 1,
    data: { method, url, status: 200 },
  });

  it('is marked writes, even when its expect named no request', () => {
    const events = [request('GET', '/api/me'), request('POST', '/api/login')];
    expect(wroteIn(events as never)).toBe(true);
    expect(wroteIn([request('GET', '/api/me')] as never)).toBe(false);
    const step = recordedStepToFlowStep({
      tool: 'reticle_act',
      stable: true,
      args: { by: 'testid', value: 'login-submit', action: 'click', args: {} },
      writes: true,
    });
    expect(step.writes).toBe(true);
    expect(replayability(flowOf([step])).why).toEqual([
      'step 1 sent a write request when it was recorded',
    ]);
  });

  it("does not count the dev server's own requests as the app's writes", () => {
    expect(wroteIn([request('POST', 'http://localhost:5173/@vite/client')] as never)).toBe(false);
  });
});

describe('a step recorded on a test id several elements share', () => {
  const act = (res: Record<string, unknown>) =>
    recordedStepToFlowStep(compileActStep({ ref: 'e5', action: 'click', args: {} }, res));

  it('is anchored on its role and name instead, with its place among namesakes', () => {
    const step = act({ testid: 'runs-result', testidOf: 6, role: 'button', name: 'Open run 12' });
    expect(step.anchor).toEqual({ kind: 'role', role: 'button', name: 'Open run 12' });
  });

  it('keeps the test id and says how many share it when nothing else names it', () => {
    const step = act({ testid: 'fact-more', testidOf: 22 });
    expect(step.anchor).toEqual({ kind: 'testid', value: 'fact-more', of: 22 });
    expect(replayability(flowOf([step])).why).toEqual([
      "step 1 anchors on test id 'fact-more', which 22 elements share",
    ]);
  });

  it('keeps a test id only one element carries', () => {
    expect(act({ testid: 'save', role: 'button', name: 'Save' }).anchor).toEqual({
      kind: 'testid',
      value: 'save',
    });
  });
});
