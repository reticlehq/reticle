import { describe, expect, it } from 'vitest';
import {
  RunAgentKind,
  RunCheckKind,
  RunCheckStatus,
  RunFlowStatus,
  RunFramework,
  RunProfile,
  RunTrigger,
  VerdictStatus,
} from '@reticlehq/protocol';
import { buildVerificationRun, type VerificationRunInput } from './build-verification-run.js';

/**
 * The generated-app bug matrix — proof that Reticle's verdict catches the silent-failure classes a
 * vibe-coded / AI-generated app (Emergent-style) exhibits. Each case models the evidence Reticle observes
 * for that bug and asserts the verdict comes back FAIL with the right signal. Deterministic, no browser
 * — the rigorous, in-CI answer to "how will Reticle check what these platforms generate?" Complements
 * false-green.test.ts (which proves a verdict can't be fabricated).
 */

const base: Omit<VerificationRunInput, 'flows' | 'checks'> = {
  runId: 'gen-app',
  durationMs: 100,
  profile: RunProfile.DEV,
  project: { name: 'generated-app', framework: RunFramework.REACT },
  agent: { id: 'oem-pipeline', kind: RunAgentKind.OEM_PIPELINE },
  trigger: { kind: RunTrigger.OEM },
  changedFiles: [],
  risks: [],
  evidence: { consoleErrors: [], networkAnomalies: [], stateAssertions: [], timeline: [] },
};

const failingCheck = (kind: RunCheckKind, predicate: string) =>
  buildVerificationRun(
    { ...base, flows: [], checks: [{ kind, predicate, status: RunCheckStatus.FAIL }] },
    () => 1,
  );

describe('Reticle catches generated-app silent-failure classes', () => {
  it('mock data instead of real persistence → state check FAILS (the #1 generated-app complaint)', () => {
    // "Looks saved" but the store/DB never changed — a `state` success-oracle catches it.
    const run = failingCheck(RunCheckKind.STATE, 'store.expenses.length increased after add');
    expect(run.verdict.status).toBe(VerdictStatus.FAIL);
    expect(run.checks[0]?.kind).toBe(RunCheckKind.STATE);
  });

  it('dead handler / UI-vs-store desync → state check FAILS', () => {
    const run = failingCheck(RunCheckKind.STATE, 'deployments.0.status === "live" after Ship');
    expect(run.verdict.status).toBe(VerdictStatus.FAIL);
  });

  it('double-submit (POST fires twice) → network cardinality check FAILS', () => {
    const run = failingCheck(
      RunCheckKind.NETWORK,
      'POST /api/expense fires exactly once (count:1)',
    );
    expect(run.verdict.status).toBe(VerdictStatus.FAIL);
    expect(run.checks[0]?.kind).toBe(RunCheckKind.NETWORK);
  });

  it('forbidden call (a must-never-fire endpoint fired) → network count:0 check FAILS', () => {
    const run = failingCheck(
      RunCheckKind.NETWORK,
      'POST /api/legacy-telemetry never fires (count:0)',
    );
    expect(run.verdict.status).toBe(VerdictStatus.FAIL);
  });

  it('missing validation (bad input accepted) → flow FAILS', () => {
    const run = buildVerificationRun(
      {
        ...base,
        checks: [],
        flows: [
          {
            name: 'reject-invalid-amount',
            status: RunFlowStatus.FAIL,
            steps: 3,
            durationMs: 20,
            oracle: 'inline error shown AND no expense created',
            failureReason: 'submitting "abc" created an expense — validation missing',
          },
        ],
      },
      () => 1,
    );
    expect(run.verdict.status).toBe(VerdictStatus.FAIL);
    expect(run.flows[0]?.failureReason).toContain('validation missing');
  });

  it('silent console error (UI still renders) → console check FAILS', () => {
    const run = failingCheck(
      RunCheckKind.CONSOLE,
      'no console.error during checkout (absent:true)',
    );
    expect(run.verdict.status).toBe(VerdictStatus.FAIL);
    expect(run.checks[0]?.kind).toBe(RunCheckKind.CONSOLE);
  });

  it('blast-radius (an action corrupts UNRELATED state, nothing visible) → state invariant FAILS', () => {
    const run = failingCheck(
      RunCheckKind.STATE,
      'deployments.0.status unchanged by Compose (invariant)',
    );
    expect(run.verdict.status).toBe(VerdictStatus.FAIL);
  });

  it('a fully-working generated app → PASS (no false positives)', () => {
    const run = buildVerificationRun(
      {
        ...base,
        checks: [
          {
            kind: RunCheckKind.NETWORK,
            predicate: 'POST /api/expense 200 count:1',
            status: RunCheckStatus.PASS,
          },
          {
            kind: RunCheckKind.STATE,
            predicate: 'store.expenses.length increased',
            status: RunCheckStatus.PASS,
          },
          {
            kind: RunCheckKind.CONSOLE,
            predicate: 'no console errors',
            status: RunCheckStatus.PASS,
          },
        ],
        flows: [
          {
            name: 'add-expense',
            status: RunFlowStatus.PASS,
            steps: 4,
            durationMs: 30,
            oracle: 'expense:saved',
          },
        ],
      },
      () => 1,
    );
    expect(run.verdict.status).toBe(VerdictStatus.PASS);
  });
});
