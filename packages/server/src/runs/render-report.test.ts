import { describe, expect, it } from 'vitest';
import {
  RiskSeverity,
  RiskSurface,
  RunAgentKind,
  RunCheckKind,
  RunCheckStatus,
  RunFlowStatus,
  RunFramework,
  RunProfile,
  RunTrigger,
} from '@reticlehq/protocol';
import { buildVerificationRun, type VerificationRunInput } from './build-verification-run.js';
import { renderRunReport } from './render-report.js';

const base: Omit<VerificationRunInput, 'flows' | 'checks' | 'risks' | 'repair'> = {
  runId: 'r',
  durationMs: 100,
  profile: RunProfile.DEV,
  project: { name: 'generated-app', framework: RunFramework.REACT },
  agent: { id: 'p', kind: RunAgentKind.OEM_PIPELINE },
  trigger: { kind: RunTrigger.OEM },
  changedFiles: [],
  evidence: { consoleErrors: [], networkAnomalies: [], stateAssertions: [], timeline: [] },
};

describe('renderRunReport', () => {
  it('renders a failing run with flows, checks, risks, repair, and reasons', () => {
    const run = buildVerificationRun(
      {
        ...base,
        flows: [
          { name: 'login', status: RunFlowStatus.PASS, steps: 3, durationMs: 20 },
          {
            name: 'checkout',
            status: RunFlowStatus.FAIL,
            steps: 4,
            durationMs: 30,
            failureReason: 'POST /api/order 500',
          },
        ],
        checks: [
          {
            kind: RunCheckKind.CONSOLE,
            predicate: 'no console errors',
            status: RunCheckStatus.FAIL,
          },
        ],
        risks: [
          {
            surface: RiskSurface.PAYMENT,
            severity: RiskSeverity.HIGH,
            detail: 'checkout changed',
            gated: true,
          },
        ],
        repair: {
          failurePackets: [
            {
              flow: 'checkout',
              expected: 'POST 200',
              actual: 'POST 500',
              sourceLocation: { file: 'src/checkout/PayButton.tsx', line: 42 },
              suggestedPrompt: 'Fix the checkout handler.',
            },
          ],
        },
      },
      () => 1,
    );
    const report = renderRunReport(run);

    expect(report).toContain('Reticle verification — generated-app  [dev]');
    expect(report).toContain('✗ FAIL');
    expect(report).toContain('✓ login');
    expect(report).toContain('✗ checkout (4 steps, 30ms) — POST /api/order 500');
    expect(report).toContain('✗ console: no console errors');
    expect(report).toContain('⚠ payment (high) [GATED] — checkout changed');
    expect(report).toContain('src/checkout/PayButton.tsx:42');
    expect(report).toContain('1 blocking risk(s)');
    expect(report).toContain('Why it failed:');
  });

  it('renders a clean PASS without risk/repair/why sections', () => {
    const run = buildVerificationRun(
      {
        ...base,
        flows: [
          {
            name: 'add-expense',
            status: RunFlowStatus.PASS,
            steps: 4,
            durationMs: 30,
            oracle: 'expense:saved',
          },
        ],
        checks: [],
        risks: [],
      },
      () => 1,
    );
    const report = renderRunReport(run);
    expect(report).toContain('✓ PASS');
    expect(report).toContain('1/1 passed');
    expect(report).not.toContain('Why it failed:');
    expect(report).not.toContain('Risks:');
  });
});
