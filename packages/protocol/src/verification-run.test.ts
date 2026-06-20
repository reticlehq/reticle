import { describe, expect, it } from 'vitest';
import {
  IrisVerificationRunSchema,
  RUN_FILE_VERSION,
  RiskSurface,
  RunAgentKind,
  RunChangeKind,
  RunFlowStatus,
  RunFramework,
  RunProfile,
  RunTrigger,
  VerdictStatus,
} from './verification-run.js';

/**
 * Contract tests for the IrisVerificationRun artifact. This is the stable shape an OEM/design partner
 * consumes, so the tests lock: a minimal run validates, arrays default to empty, a full failing run
 * with risks + a repair packet validates, and bad version/enum values are rejected.
 */

const minimal = {
  schemaVersion: RUN_FILE_VERSION,
  runId: 'run-1',
  createdAt: 1234,
  durationMs: 500,
  profile: RunProfile.DEV,
  project: { name: 'demo', framework: RunFramework.REACT },
  agent: { id: 'agent-1', kind: RunAgentKind.CODING_AGENT },
  trigger: { kind: RunTrigger.EDIT },
  evidence: {},
  verdict: { status: VerdictStatus.PASS, confidence: 'high' },
};

describe('IrisVerificationRunSchema', () => {
  it('parses a minimal run and applies array defaults', () => {
    const parsed = IrisVerificationRunSchema.safeParse(minimal);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.flows).toEqual([]);
      expect(parsed.data.checks).toEqual([]);
      expect(parsed.data.risks).toEqual([]);
      expect(parsed.data.changedFiles).toEqual([]);
      expect(parsed.data.evidence.consoleErrors).toEqual([]);
      expect(parsed.data.verdict.reasons).toEqual([]);
      expect(parsed.data.verdict.blockingRisks).toBe(0);
    }
  });

  it('parses a full failing run with risks, a failed flow, and a repair packet', () => {
    const full = {
      ...minimal,
      trigger: { kind: RunTrigger.OEM, diffRef: 'abc123' },
      changedFiles: [
        {
          path: 'src/checkout/PayButton.tsx',
          changeKind: RunChangeKind.MODIFIED,
          risk: [RiskSurface.PAYMENT],
        },
      ],
      flows: [
        {
          name: 'checkout',
          status: RunFlowStatus.FAIL,
          steps: 4,
          durationMs: 320,
          oracle: 'order:saved',
          failureReason: 'POST /api/order returned 500, expected 200',
        },
      ],
      risks: [
        {
          surface: RiskSurface.PAYMENT,
          severity: 'high',
          detail: 'checkout path modified',
          gated: true,
        },
      ],
      evidence: {
        networkAnomalies: [
          { method: 'POST', url: '/api/order', status: 500, issue: 'expected 200' },
        ],
      },
      repair: {
        failurePackets: [
          {
            flow: 'checkout',
            step: 3,
            expected: 'POST /api/order -> 200',
            actual: 'POST /api/order -> 500',
            sourceLocation: {
              file: 'src/checkout/PayButton.tsx',
              line: 42,
              component: 'PayButton',
            },
            suggestedPrompt:
              'PayButton at src/checkout/PayButton.tsx:42 posts to /api/order and gets 500; fix the handler.',
          },
        ],
      },
      verdict: {
        status: VerdictStatus.FAIL,
        reasons: ['checkout failed'],
        confidence: 'high',
        blockingRisks: 1,
      },
    };
    const parsed = IrisVerificationRunSchema.safeParse(full);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.flows[0]?.status).toBe(RunFlowStatus.FAIL);
      expect(parsed.data.repair?.failurePackets[0]?.sourceLocation?.line).toBe(42);
      expect(parsed.data.verdict.blockingRisks).toBe(1);
    }
  });

  it('rejects a wrong schemaVersion', () => {
    const parsed = IrisVerificationRunSchema.safeParse({ ...minimal, schemaVersion: 999 });
    expect(parsed.success).toBe(false);
  });

  it('rejects an unknown verdict status', () => {
    const parsed = IrisVerificationRunSchema.safeParse({
      ...minimal,
      verdict: { status: 'maybe', confidence: 'high' },
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects an unknown risk surface', () => {
    const parsed = IrisVerificationRunSchema.safeParse({
      ...minimal,
      risks: [{ surface: 'quantum', severity: 'low', detail: 'x' }],
    });
    expect(parsed.success).toBe(false);
  });
});
