import { describe, expect, it } from 'vitest';
import {
  RUN_FILE_VERSION,
  RiskSeverity,
  RiskSurface,
  RunAgentKind,
  RunCheckKind,
  RunCheckStatus,
  RunConfidence,
  RunFlowStatus,
  RunFramework,
  RunProfile,
  RunTrigger,
  VerdictStatus,
} from '@reticlehq/core';
import {
  buildVerificationRun,
  computeVerdict,
  type VerificationRunInput,
} from './build-verification-run.js';

const FROZEN = 1_700_000_000_000;

const base: VerificationRunInput = {
  runId: 'run-1',
  durationMs: 100,
  profile: RunProfile.DEV,
  project: { name: 'demo', framework: RunFramework.REACT },
  agent: { id: 'a', kind: RunAgentKind.CODING_AGENT },
  trigger: { kind: RunTrigger.EDIT },
  changedFiles: [],
  flows: [],
  checks: [],
  risks: [],
  evidence: { consoleErrors: [], networkAnomalies: [], stateAssertions: [], timeline: [] },
};

const flow = (name: string, status: RunFlowStatus, oracle?: string) => ({
  name,
  status,
  steps: 2,
  durationMs: 10,
  ...(oracle !== undefined ? { oracle } : {}),
});

describe('computeVerdict', () => {
  it('all flows pass → PASS, HIGH confidence when oracle-backed', () => {
    const v = computeVerdict({ ...base, flows: [flow('a', RunFlowStatus.PASS, 'order:saved')] });
    expect(v.status).toBe(VerdictStatus.PASS);
    expect(v.confidence).toBe(RunConfidence.HIGH);
    expect(v.blockingRisks).toBe(0);
  });

  it('a healed flow counts as a pass', () => {
    const v = computeVerdict({ ...base, flows: [flow('a', RunFlowStatus.HEALED, 'x')] });
    expect(v.status).toBe(VerdictStatus.PASS);
  });

  it('mixed pass + fail → PARTIAL', () => {
    const v = computeVerdict({
      ...base,
      flows: [flow('a', RunFlowStatus.PASS, 'x'), flow('b', RunFlowStatus.FAIL, 'y')],
    });
    expect(v.status).toBe(VerdictStatus.PARTIAL);
    expect(v.reasons.some((r) => r.includes('flow b'))).toBe(true);
  });

  it('only failures → FAIL', () => {
    const v = computeVerdict({ ...base, flows: [flow('b', RunFlowStatus.FAIL)] });
    expect(v.status).toBe(VerdictStatus.FAIL);
  });

  it('a gated risk blocks even when everything else passed', () => {
    const v = computeVerdict({
      ...base,
      flows: [flow('a', RunFlowStatus.PASS, 'x')],
      risks: [
        {
          surface: RiskSurface.PAYMENT,
          severity: RiskSeverity.HIGH,
          detail: 'checkout changed',
          gated: true,
        },
      ],
    });
    expect(v.status).toBe(VerdictStatus.FAIL);
    expect(v.blockingRisks).toBe(1);
    expect(v.reasons.some((r) => r.includes('blocked'))).toBe(true);
  });

  it('a failing check fails the run', () => {
    const v = computeVerdict({
      ...base,
      checks: [
        { kind: RunCheckKind.NETWORK, predicate: 'POST /api 200', status: RunCheckStatus.FAIL },
      ],
    });
    expect(v.status).toBe(VerdictStatus.FAIL);
  });

  it('nothing ran → PASS but LOW confidence', () => {
    const v = computeVerdict(base);
    expect(v.status).toBe(VerdictStatus.PASS);
    expect(v.confidence).toBe(RunConfidence.LOW);
  });

  it('smoke flow with no oracle and no checks → MEDIUM confidence', () => {
    const v = computeVerdict({ ...base, flows: [flow('a', RunFlowStatus.PASS)] });
    expect(v.confidence).toBe(RunConfidence.MEDIUM);
  });
});

describe('buildVerificationRun', () => {
  it('stamps schemaVersion + createdAt from the injected clock and is schema-valid', () => {
    const run = buildVerificationRun(
      { ...base, flows: [flow('a', RunFlowStatus.PASS, 'x')] },
      () => FROZEN,
    );
    expect(run.schemaVersion).toBe(RUN_FILE_VERSION);
    expect(run.createdAt).toBe(FROZEN);
    expect(run.verdict.status).toBe(VerdictStatus.PASS);
    expect(run.runId).toBe('run-1');
  });
});
