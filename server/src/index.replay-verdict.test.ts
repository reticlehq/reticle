import { describe, expect, it } from 'vitest';
import { ReplayStatus, type FlowReplayResult } from '@reticlehq/core';
import { replayVerdictLine } from './index.js';

describe('replayVerdictLine — human-facing CLI replay summary', () => {
  it('formats an OK replay with a checkmark', () => {
    const result: FlowReplayResult = { name: 'checkout', status: ReplayStatus.OK, steps: [] };
    expect(replayVerdictLine(result)).toBe('✓ "checkout" passed');
  });

  it('formats a DRIFT replay with a warning sign', () => {
    const result: FlowReplayResult = { name: 'checkout', status: ReplayStatus.DRIFT, steps: [] };
    expect(replayVerdictLine(result)).toBe('⚠ "checkout" drifted — a step no longer matches');
  });

  it('formats an ERROR replay with a failure cross', () => {
    const result: FlowReplayResult = {
      name: 'checkout',
      status: ReplayStatus.ERROR,
      steps: [],
      error: { code: 'error', message: 'connection refused' },
    };
    expect(replayVerdictLine(result)).toBe('✗ "checkout" failed — connection refused');
  });

  it('formats an UNVERIFIABLE replay distinctly with a question mark and reason', () => {
    const result: FlowReplayResult = {
      name: 'checkout',
      status: ReplayStatus.UNVERIFIABLE,
      steps: [],
      unverifiable: { reason: 'precondition unmet' },
    };
    const line = replayVerdictLine(result);
    expect(line).toBe('? "checkout" unverifiable — precondition unmet');
    expect(line).not.toContain('✓');
    expect(line).not.toContain('✗');
    expect(line).not.toContain('passed');
    expect(line).not.toContain('failed');
  });

  it('formats an UNVERIFIABLE replay with default fallback if reason is absent', () => {
    const result: FlowReplayResult = {
      name: 'checkout',
      status: ReplayStatus.UNVERIFIABLE,
      steps: [],
    };
    expect(replayVerdictLine(result)).toBe('? "checkout" unverifiable — could not be graded');
  });
});
