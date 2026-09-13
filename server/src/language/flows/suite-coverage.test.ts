import { describe, expect, it } from 'vitest';
import {
  ActionType,
  AnchorKind,
  FLOW_FILE_VERSION,
  ReplayStatus,
  ReticleTool,
  type FlowFile,
  type FlowReplayResult,
  type FlowStep,
} from '@reticlehq/core';
import { buildSuiteVerdict } from './decision.js';

/**
 * A suite that passed says how much of what it drove it actually PROVED.
 *
 * `unverifiable` already catches a flow that asserts nothing at all. It cannot catch the commoner
 * shape: a flow of twelve steps where three declare a consequence and nine do not. That flow passes,
 * is counted in `passed`, and nine of its steps would have replayed green whether or not the feature
 * worked.
 *
 * So the count travels. Sixty-three steps driven and forty-seven declared is not "75% verified" — it
 * is verified for forty-seven and silent about sixteen, and only a number that reports both lets a
 * reader tell those apart.
 */
const step = (declares: boolean): FlowStep => {
  const s: FlowStep = {
    tool: ReticleTool.ACT,
    anchor: { kind: AnchorKind.TESTID, value: 'x' },
    action: ActionType.CLICK,
    args: {},
  };
  if (declares) s.expect = { signal: 'saved' };
  return s;
};

const flow = (name: string, steps: FlowStep[]): FlowFile => ({
  version: FLOW_FILE_VERSION,
  name,
  createdAt: 0,
  steps,
  success: { signal: 'done' },
});

const ok = (name: string): FlowReplayResult => ({
  name,
  status: ReplayStatus.OK,
  steps: [],
});

describe('a suite verdict carries how much it proved', () => {
  it('counts steps driven and steps that declared a consequence', () => {
    const verdict = buildSuiteVerdict([
      { replay: ok('a'), flow: flow('a', [step(true), step(false), step(false)]) },
      { replay: ok('b'), flow: flow('b', [step(true), step(true)]) },
    ]);

    expect(verdict.coverage).toEqual({ steps: 5, declared: 3 });
  });

  it('says so in the summary when part of the suite proved nothing', () => {
    const verdict = buildSuiteVerdict([
      { replay: ok('a'), flow: flow('a', [step(true), step(false), step(false)]) },
    ]);

    expect(verdict.summary).toContain('1 of 3');
  });

  it('stays quiet when every step declared — there is nothing to warn about', () => {
    const verdict = buildSuiteVerdict([
      { replay: ok('a'), flow: flow('a', [step(true), step(true)]) },
    ]);

    expect(verdict.coverage).toEqual({ steps: 2, declared: 2 });
    expect(verdict.summary).not.toContain(' of 2 ');
  });

  it('omits coverage entirely when no flow file was available to count', () => {
    // A replay whose file could not be loaded cannot be counted, and inventing a zero would read as
    // "nothing was declared" rather than "nothing was counted".
    const verdict = buildSuiteVerdict([{ replay: ok('a') }]);
    expect(verdict.coverage).toBeUndefined();
  });
});
