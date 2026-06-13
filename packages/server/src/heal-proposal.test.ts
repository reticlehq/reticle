import { describe, expect, it } from 'vitest';
import {
  DriftReason,
  HEAL_CONFIDENCE_MIN,
  type Drift,
  type FlowStepResult,
} from '@syrin/iris-protocol';
import { collectProposals, confidenceFor, proposeRebind } from './heal.js';
import { IrisTool } from './tool-names.js';

/**
 * M8 Stage B SELFHEAL — Suite 1: pure proposal layer (no fs, no session). Confidence is derived
 * purely from the existing case-insensitive edit distance, normalized to (0,1]; a rebind is only
 * proposed for a TESTID drift whose nearest present testid clears HEAL_CONFIDENCE_MIN.
 */

function testidDrift(from: string, nearest: string | null): Drift {
  return {
    reasonKind: DriftReason.TESTID_NOT_FOUND,
    reason: `testid "${from}" not found`,
    anchor: from,
    nearest,
  };
}

function signalDrift(name: string): Drift {
  return {
    reasonKind: DriftReason.SIGNAL_NOT_OBSERVED,
    reason: `signal "${name}" not observed`,
    anchor: name,
    nearest: null,
  };
}

describe('confidenceFor — normalized edit-distance confidence (SELFHEAL)', () => {
  it('S1.2: confidence is higher for a smaller edit distance', () => {
    expect(confidenceFor('chat-send', 'chat-sent')).toBeGreaterThan(
      confidenceFor('chat-send', 'totally-different-id'),
    );
  });

  it('S1.3: confidence is normalized to (0,1] and 1 only on exact match', () => {
    expect(confidenceFor('x', 'x')).toBe(1);
    const near = confidenceFor('chat-send', 'chat-sent');
    expect(near).toBeLessThan(1);
    expect(near).toBeGreaterThan(0);
    const far = confidenceFor('save', 'delete-everything');
    expect(far).toBeLessThan(1);
    expect(far).toBeGreaterThan(0);
  });
});

describe('proposeRebind — confident testid rebind, else undefined (SELFHEAL)', () => {
  it('S1.1: proposes a rebind when drift has a near-identical nearest', () => {
    const proposal = proposeRebind(testidDrift('chat-send', 'chat-sent'), 0);
    expect(proposal?.step).toBe(0);
    expect(proposal?.from).toBe('chat-send');
    expect(proposal?.to).toBe('chat-sent');
    expect(proposal?.confidence).toBeGreaterThanOrEqual(HEAL_CONFIDENCE_MIN);
  });

  it('S1.4: no proposal when nearest is null (page has no testids)', () => {
    expect(proposeRebind(testidDrift('chat-send', null), 0)).toBeUndefined();
  });

  it('S1.5: no proposal when nearest is below the confidence floor', () => {
    // 'save' vs 'delete-everything' is far → confidence < HEAL_CONFIDENCE_MIN → not a silent rewrite.
    expect(confidenceFor('save', 'delete-everything')).toBeLessThan(HEAL_CONFIDENCE_MIN);
    expect(proposeRebind(testidDrift('save', 'delete-everything'), 2)).toBeUndefined();
  });

  it('S1.6: signal drift never proposes (no nearest for signals)', () => {
    expect(proposeRebind(signalDrift('diff:shown'), 0)).toBeUndefined();
  });

  it('S1.7: non-testid drift kind is ignored', () => {
    // A drift carrying a nearest but the wrong reasonKind must not produce a proposal.
    const drift: Drift = {
      reasonKind: DriftReason.SIGNAL_NOT_OBSERVED,
      reason: 'signal not observed',
      anchor: 'chat-send',
      nearest: 'send-message',
    };
    expect(proposeRebind(drift, 0)).toBeUndefined();
  });
});

describe('collectProposals — confident proposals across step results (SELFHEAL)', () => {
  function driftStep(step: number, from: string, nearest: string | null): FlowStepResult {
    return { step, tool: IrisTool.ACT, anchor: from, ok: false, drift: testidDrift(from, nearest) };
  }
  function okStep(step: number, anchor: string): FlowStepResult {
    return { step, tool: IrisTool.ACT, anchor, ok: true };
  }

  it('skips ok steps and low-confidence drift; keeps only confident rebinds in order', () => {
    const proposals = collectProposals([
      okStep(0, 'a'),
      driftStep(1, 'chat-send', 'chat-sent'),
      driftStep(2, 'save', 'delete-everything'),
      driftStep(3, 'gone', null),
    ]);
    expect(proposals.map((p) => p.step)).toEqual([1]);
    expect(proposals[0]?.to).toBe('chat-sent');
  });

  it('an all-green replay yields no proposals', () => {
    expect(collectProposals([okStep(0, 'a'), okStep(1, 'b')])).toEqual([]);
  });
});
