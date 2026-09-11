import { describe, expect, it } from 'vitest';
import { RunKind, RunStatus, type RunRecord } from '@reticlehq/core';
import { FlowAssertionGrade } from '../flows/flow-classify.js';
import { flowRisk, latestRun, rankByRisk, RiskLevel } from './flow-risk.js';

function run(
  name: string,
  status: RunStatus,
  at: number,
  extra: Partial<RunRecord> = {},
): RunRecord {
  return { kind: RunKind.FLOW_REPLAY, name, status, at, ...extra };
}

describe('latestRun', () => {
  it('picks the most recent run for the name', () => {
    const runs = [
      run('a', RunStatus.PASS, 1),
      run('a', RunStatus.ERROR, 3),
      run('a', RunStatus.PASS, 2),
    ];
    expect(latestRun('a', runs)?.at).toBe(3);
  });
  it('is undefined when the flow was never run', () => {
    expect(latestRun('x', [run('a', RunStatus.PASS, 1)])).toBeUndefined();
  });
});

describe('flowRisk — worse of run-history and assertion quality', () => {
  it('a failed last run is high regardless of grade', () => {
    expect(flowRisk(FlowAssertionGrade.ASSERTED, run('a', RunStatus.ERROR, 1)).level).toBe(
      RiskLevel.HIGH,
    );
  });
  it('a clean asserted run is low', () => {
    expect(flowRisk(FlowAssertionGrade.ASSERTED, run('a', RunStatus.PASS, 1)).level).toBe(
      RiskLevel.LOW,
    );
  });
  it('a clean run with logged errors is medium', () => {
    const r = run('a', RunStatus.PASS, 1, { evidence: { consoleErrors: 2 } });
    expect(flowRisk(FlowAssertionGrade.ASSERTED, r).level).toBe(RiskLevel.MEDIUM);
  });
  it('a clean run of an assertion-free flow is still medium (false confidence)', () => {
    expect(flowRisk(FlowAssertionGrade.ASSERTION_FREE, run('a', RunStatus.PASS, 1)).level).toBe(
      RiskLevel.MEDIUM,
    );
  });
  it('a never-run flow is unknown', () => {
    expect(flowRisk(FlowAssertionGrade.ASSERTED, undefined).level).toBe(RiskLevel.UNKNOWN);
  });
});

describe('rankByRisk', () => {
  it('orders worst-first, ties broken by name', () => {
    const ranked = rankByRisk([
      { name: 'b', risk: { level: RiskLevel.LOW, reason: '' } },
      { name: 'a', risk: { level: RiskLevel.HIGH, reason: '' } },
      { name: 'c', risk: { level: RiskLevel.LOW, reason: '' } },
    ]);
    expect(ranked).toEqual(['a', 'b', 'c']);
  });
});
