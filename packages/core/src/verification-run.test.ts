import { describe, expect, it } from 'vitest';
import {
  ReticleVerificationRunSchema,
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
 * Contract tests for the ReticleVerificationRun artifact. This is the stable shape an OEM/design partner
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

describe('ReticleVerificationRunSchema', () => {
  it('parses a minimal run and applies array defaults', () => {
    const parsed = ReticleVerificationRunSchema.safeParse(minimal);
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
    const parsed = ReticleVerificationRunSchema.safeParse(full);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.flows[0]?.status).toBe(RunFlowStatus.FAIL);
      expect(parsed.data.repair?.failurePackets[0]?.sourceLocation?.line).toBe(42);
      expect(parsed.data.verdict.blockingRisks).toBe(1);
    }
  });

  it('rejects a wrong schemaVersion', () => {
    const parsed = ReticleVerificationRunSchema.safeParse({ ...minimal, schemaVersion: 999 });
    expect(parsed.success).toBe(false);
  });

  it('rejects an unknown verdict status', () => {
    const parsed = ReticleVerificationRunSchema.safeParse({
      ...minimal,
      verdict: { status: 'maybe', confidence: 'high' },
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects an unknown risk surface', () => {
    const parsed = ReticleVerificationRunSchema.safeParse({
      ...minimal,
      risks: [{ surface: 'quantum', severity: 'low', detail: 'x' }],
    });
    expect(parsed.success).toBe(false);
  });

  // CONTRACT LOCK: this frozen v1 artifact is the public wire shape a partner depends on. It must keep
  // parsing forever within RUN_FILE_VERSION 1 — a failure here means a breaking change that needs a
  // version bump, not a silent edit. Do not "fix" by editing the fixture; bump the version instead.
  it('locks v1 back-compat: a frozen full v1 artifact always parses', () => {
    const frozenV1 = {
      schemaVersion: 1,
      runId: 'run-frozen',
      createdAt: 1_700_000_000_000,
      durationMs: 1234,
      profile: 'prod-preview',
      project: { name: 'app', framework: 'next', commit: 'abc', env: 'ci', previewUrl: 'http://x' },
      agent: { id: 'pipeline', kind: 'oem-pipeline', model: 'm' },
      trigger: { kind: 'oem', diffRef: 'sha', note: 'n' },
      changedFiles: [{ path: 'src/a.ts', changeKind: 'modified', risk: ['payment'] }],
      flows: [
        {
          name: 'checkout',
          status: 'fail',
          steps: 4,
          durationMs: 30,
          oracle: 'order:saved',
          failureReason: 'x',
          evidenceRef: 'e1',
        },
      ],
      checks: [
        { kind: 'network', predicate: 'POST 200', status: 'fail', evidence: { status: 500 } },
      ],
      risks: [{ surface: 'payment', severity: 'high', detail: 'd', gated: true }],
      evidence: {
        consoleErrors: [{ level: 'error', message: 'boom', at: 1 }],
        networkAnomalies: [{ method: 'POST', url: '/x', status: 500, issue: 'i' }],
        stateAssertions: [{ store: 'cart', path: 'len', expected: 1, actual: 0, ok: false }],
        timeline: [{ at: 1, kind: 'net', summary: 's' }],
      },
      repair: { failurePackets: [{ expected: 'a', actual: 'b', suggestedPrompt: 'fix it' }] },
      verdict: {
        status: 'fail',
        reasons: ['checkout failed'],
        confidence: 'high',
        blockingRisks: 1,
      },
      signature: { alg: 'ed25519', value: 'sig', signedAt: 2 },
    };
    expect(ReticleVerificationRunSchema.safeParse(frozenV1).success).toBe(true);
  });
});
