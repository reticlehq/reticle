import { describe, expect, it } from 'vitest';
import { RunAgentKind, RunFramework, RunProfile, RunTrigger } from '@syrin/iris-protocol';
import { buildVerificationRun, type VerificationRunInput } from './build-verification-run.js';
import { REDACTED, redactForProfile } from './profile-redact.js';

const inputFor = (profile: RunProfile): VerificationRunInput => ({
  runId: 'r',
  durationMs: 1,
  profile,
  project: { name: 'demo', framework: RunFramework.REACT },
  agent: { id: 'a', kind: RunAgentKind.OEM_PIPELINE },
  trigger: { kind: RunTrigger.OEM },
  changedFiles: [],
  flows: [],
  checks: [],
  risks: [],
  evidence: {
    consoleErrors: [],
    networkAnomalies: [],
    stateAssertions: [{ store: 'cart', path: 'len', expected: 1, actual: 0, ok: false }],
    timeline: [],
  },
  repair: {
    failurePackets: [
      {
        flow: 'a',
        expected: 'x',
        actual: 'y',
        sourceLocation: { file: 'src/a.ts', line: 1 },
        suggestedPrompt: 'Fix a. Look at src/a.ts:1.',
      },
    ],
  },
});

describe('profile gating', () => {
  it('DEV keeps repair and raw state-assertion values', () => {
    const run = buildVerificationRun(inputFor(RunProfile.DEV), () => 1);
    expect(run.repair?.failurePackets).toHaveLength(1);
    expect(run.evidence.stateAssertions[0]?.expected).toBe(1);
  });

  it('redactForProfile strips repair + state values for PROD_PREVIEW, keeping verdict + ok flags', () => {
    const dev = buildVerificationRun(inputFor(RunProfile.DEV), () => 1);
    const redacted = redactForProfile({ ...dev, profile: RunProfile.PROD_PREVIEW });
    expect(redacted.repair).toBeUndefined();
    expect(redacted.evidence.stateAssertions[0]?.expected).toBe(REDACTED);
    expect(redacted.evidence.stateAssertions[0]?.actual).toBe(REDACTED);
    expect(redacted.evidence.stateAssertions[0]?.ok).toBe(false);
    expect(redacted.verdict).toEqual(dev.verdict);
  });

  it('buildVerificationRun applies redaction at build time for a PROD_PREVIEW run', () => {
    const run = buildVerificationRun(inputFor(RunProfile.PROD_PREVIEW), () => 1);
    expect(run.repair).toBeUndefined();
    expect(run.evidence.stateAssertions[0]?.expected).toBe(REDACTED);
  });
});
