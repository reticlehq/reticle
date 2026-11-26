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
import { compileActStep, WriteOutcome, wroteIn } from './replay.js';
import { buildSuiteVerdict } from './decision.js';
import { writingFlows } from './suite-selection.js';
import { readyForReplay, replayability, Replayable, replaysAsSaved } from './flow-replayable.js';

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

  // #2469: "3 results" saved as words plus any number, and the save said nothing. A replay after
  // the count changed then passed. The loss must be declared (AGENTS rule 11).
  it('names each step whose number it no longer checks, and how to keep it', () => {
    const ready = readyForReplay(
      flowOf([click('filter', { kind: 'text', contains: '3 results' })]),
    );
    const report = replayability(ready);
    expect(report.status).toBe(Replayable.YES);
    expect(report.relaxed?.join(' ')).toMatch(/step 1 checks 'N results' with any number/);
    expect(report.relaxed?.join(' ')).toContain('matchesPattern');
    expect(replaysAsSaved(report)).toBe(false);
  });

  it('says nothing about a text check with no number', () => {
    const ready = readyForReplay(flowOf([click('tab', { kind: 'text', contains: 'Saved' })]));
    const report = replayability(ready);
    expect(report.relaxed).toBeUndefined();
    expect(replaysAsSaved(report)).toBe(true);
  });

  // "3 items" is absent. Made word-level, it said that no "<number> items" is on the page, so a
  // page that shows "5 items" failed on replay while the drive had passed: a false `no`.
  it('keeps an absent count exact, because any count would then fail it', () => {
    const absent = { kind: 'text', contains: '3 items', absent: true } as const;
    const ready = readyForReplay(flowOf([click('tab', absent)]));
    expect(ready.steps[0]?.expect).toEqual(absent);
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

  // A navigation flow checked that no POST went out. Its `count: 0` named a POST, so the flow
  // was marked a write flow, and `skipWrites` held back a flow that writes nothing.
  it('does not mark a step whose expect forbids a write request', () => {
    const post = { kind: 'net', method: 'POST', urlContains: '/api' } as const;
    const forbids = readyForReplay(
      flowOf([
        click('menu', { ...post, count: 0 }),
        click('link', { kind: 'not', predicate: post }),
        click('tab', {
          kind: 'allOf',
          predicates: [
            { kind: 'route', pathname: '/issues' },
            { kind: 'not', predicate: { kind: 'anyOf', predicates: [post] } },
          ],
        }),
      ]),
    );
    expect(forbids.steps.map((step) => step.writes)).toEqual([undefined, undefined, undefined]);
    expect(replayability(forbids)).toEqual({ status: Replayable.YES });
  });

  it('still marks a step whose expect asks for a write request, a negated absence too', () => {
    const post = { kind: 'net', method: 'POST', urlContains: '/api' } as const;
    const sends = readyForReplay(
      flowOf([
        click('save', { ...post, count: 1 }),
        click('send', { kind: 'not', predicate: { ...post, count: 0 } }),
        click('again', { kind: 'not', predicate: { kind: 'not', predicate: post } }),
      ]),
    );
    expect(sends.steps.map((step) => step.writes)).toEqual([true, true, true]);
    expect(replayability(sends).why).toEqual([
      'step 1 sends POST /api',
      'step 2 sends POST /api',
      'step 3 sends POST /api',
    ]);
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

  // #2469: a pass on a step whose number save loosened did not check that number. The suite says so
  // on every replay, not only when the flow was saved.
  it('names a passing flow whose text check accepts any number', () => {
    const passed = { name: 'filtered', status: ReplayStatus.OK, steps: [] };
    const flow = readyForReplay(flowOf([click('f', { kind: 'text', contains: '3 results' })]));
    const verdict = buildSuiteVerdict([{ replay: passed, flow }]);
    expect(verdict.replayability?.[0]).toMatchObject({ flow: 'filtered', status: Replayable.YES });
    expect(verdict.summary).toMatch(
      /1 of 1 flows passed a text check that accepts any number \(filtered\)/,
    );
  });

  it('says nothing about any number when that flow did not pass', () => {
    const drifted = { name: 'filtered', status: ReplayStatus.DRIFT, steps: [] };
    const flow = readyForReplay(flowOf([click('f', { kind: 'text', contains: '3 results' })]));
    expect(buildSuiteVerdict([{ replay: drifted, flow }]).summary).not.toMatch(/any number/);
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

// Before #2497, save marked a step `writes` when its expect only forbade a write request, and the
// flow file keeps that mark. The recorder's own mark looks the same, so the mark stays and the flow
// is still held back; the report must not claim the recording sent a write, and must say how to clear it.
describe('a flow saved with a forbidden request marked as a write', () => {
  const forbids = { kind: 'net', method: 'POST', urlContains: '/api', count: 0 } as const;
  const saved = flowOf([{ ...click('menu', forbids), writes: true }], { name: 'nav' });

  it('is still held back by skipWrites, and the report names the forbidden request', () => {
    expect(writingFlows([saved])).toEqual(['nav']);
    expect(replayability(readyForReplay(saved)).why).toEqual([
      'step 1 is marked as a write, but its expect forbids POST /api. An older version marked such a step. If the step sends no write request, remove "writes": true from the step in the flow file',
    ]);
  });

  it('runs once the mark is removed from the file', () => {
    const cleared = flowOf([click('menu', forbids)], { name: 'nav' });
    expect(writingFlows([cleared])).toEqual([]);
    expect(replayability(readyForReplay(cleared))).toEqual({ status: Replayable.YES });
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
    expect(wroteIn(events as never)).toBe(WriteOutcome.SENT);
    expect(wroteIn([request('GET', '/api/me')] as never)).toBeUndefined();
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
    expect(
      wroteIn([request('POST', 'http://localhost:5173/@vite/client')] as never),
    ).toBeUndefined();
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
