import { describe, expect, it } from 'vitest';
import {
  ReplayStatus,
  type FlowReplayResult,
  type FlowStepResult,
  type ReplayDecision,
} from '@reticle/protocol';
import { buildRepairPacket, buildRepairPackets } from './repair-prompt.js';

const step = (n: number, ok: boolean): FlowStepResult => ({
  step: n,
  tool: 'reticle_act',
  anchor: 'x',
  ok,
});

const replay = (status: ReplayStatus, extra?: Partial<FlowReplayResult>): FlowReplayResult => ({
  name: 'checkout',
  status,
  steps: [],
  ...extra,
});

const decision = (over: Partial<ReplayDecision>): ReplayDecision => ({
  verdict: 'fail',
  summary: 'checkout failed',
  nextAction: 'check the handler',
  ...over,
});

describe('buildRepairPacket', () => {
  it('returns undefined for a passing replay', () => {
    expect(buildRepairPacket(replay(ReplayStatus.OK))).toBeUndefined();
  });

  it('builds a packet from an error replay (no decision), picking the failing step', () => {
    const packet = buildRepairPacket(
      replay(ReplayStatus.ERROR, {
        steps: [step(0, true), step(1, false)],
        error: { code: 'e', message: 'POST /api/order 500' },
      }),
    );
    expect(packet?.flow).toBe('checkout');
    expect(packet?.step).toBe(1);
    expect(packet?.actual).toBe('POST /api/order 500');
    expect(packet?.sourceLocation).toBeUndefined();
    expect(packet?.suggestedPrompt).toContain('Fix the "checkout" flow.');
    expect(packet?.suggestedPrompt).toContain('POST /api/order 500.');
  });

  it('lifts whatChanged + file:line + nextAction into a paste-ready prompt', () => {
    const packet = buildRepairPacket(
      replay(ReplayStatus.DRIFT, {
        steps: [step(0, false)],
        decision: decision({
          whatChanged: 'anchor gone',
          whereInSource: 'src/Pay.tsx:42',
          nextAction: 'rebind it',
        }),
      }),
    );
    expect(packet?.actual).toBe('anchor gone');
    expect(packet?.sourceLocation).toEqual({ file: 'src/Pay.tsx', line: 42 });
    expect(packet?.suggestedPrompt).toContain('Look at src/Pay.tsx:42.');
    expect(packet?.suggestedPrompt).toContain('rebind it');
  });

  it('does not treat a page URL as a source location', () => {
    const packet = buildRepairPacket(
      replay(ReplayStatus.ERROR, {
        decision: decision({ whatChanged: 'x', whereInSource: 'http://localhost:3000' }),
      }),
    );
    expect(packet?.sourceLocation).toBeUndefined();
  });
});

describe('buildRepairPackets', () => {
  it('keeps only the failed replays', () => {
    const packets = buildRepairPackets([
      replay(ReplayStatus.OK),
      replay(ReplayStatus.ERROR, { name: 'a', error: { code: 'e', message: 'boom' } }),
    ]);
    expect(packets).toHaveLength(1);
    expect(packets[0]?.flow).toBe('a');
  });
});
