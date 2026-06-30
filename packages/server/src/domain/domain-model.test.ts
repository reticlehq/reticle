import { describe, expect, it } from 'vitest';
import {
  FLOW_FILE_VERSION,
  AnchorKind,
  type CapabilitiesContract,
  type FlowExpect,
  type FlowFile,
  type FlowStep,
} from '@reticle/protocol';
import { ReticleTool } from '../tools/tool-names.js';
import { buildDomainModel } from './domain-model.js';

function testidStep(value: string): FlowStep {
  return { tool: ReticleTool.ACT, anchor: { kind: AnchorKind.TESTID, value } };
}

function flow(name: string, steps: FlowStep[], success?: FlowExpect): FlowFile {
  const f: FlowFile = { version: FLOW_FILE_VERSION, name, createdAt: 0, steps };
  if (success !== undefined) f.success = success;
  return f;
}

const contract = (over: Partial<CapabilitiesContract> = {}): CapabilitiesContract => ({
  testids: over.testids ?? [],
  signals: over.signals ?? [],
  stores: over.stores ?? [],
  flows: over.flows ?? [],
});

describe('buildDomainModel', () => {
  it('summarizes each flow with its assertion grade + anchors used', () => {
    const m = buildDomainModel(
      [flow('checkout', [testidStep('pay')], { signal: 'order:placed' })],
      contract(),
    );
    expect(m.flowCount).toBe(1);
    expect(m.flows[0]?.name).toBe('checkout');
    expect(m.flows[0]?.grade).toBe('asserted');
    expect(m.flows[0]?.signals).toEqual(['order:placed']);
    expect(m.flows[0]?.testids).toEqual(['pay']);
    expect(m.coverage.asserted).toBe(1);
  });

  it('surfaces mustHold — what must hold for each flow — from its success consequence', () => {
    const m = buildDomainModel(
      [
        flow('checkout', [testidStep('pay')], { signal: 'order:placed' }),
        flow('browse', [testidStep('nav')]), // no success declared
      ],
      contract(),
    );
    const checkout = m.flows.find((f) => f.name === 'checkout');
    const browse = m.flows.find((f) => f.name === 'browse');
    expect(checkout?.mustHold).toBe('order:placed'); // the consequence that must hold
    expect(browse?.mustHold).toBeUndefined(); // tests nothing observable
    expect(browse?.asserts).toBe(false);
  });

  it('flags declared signals that NO flow asserts (untested intent — the differentiator)', () => {
    const m = buildDomainModel(
      [flow('checkout', [testidStep('pay')], { signal: 'order:placed' })],
      contract({ signals: ['order:placed', 'refund:issued'], testids: ['pay', 'refund-btn'] }),
    );
    expect(m.gaps.declaredUntestedSignals).toEqual(['refund:issued']);
    expect(m.gaps.declaredUntestedTestids).toEqual(['refund-btn']);
    expect(m.summary).toContain('refund:issued');
  });

  it('lists unasserted flows as a gap', () => {
    const m = buildDomainModel(
      [flow('browse', [testidStep('nav')]), flow('buy', [testidStep('pay')], { signal: 'done' })],
      contract(),
    );
    expect(m.gaps.unassertedFlows).toEqual(['browse']);
    expect(m.coverage.assertionFree).toBe(1);
    expect(m.coverage.asserted).toBe(1);
  });

  it('handles no contract (null) without crashing', () => {
    const m = buildDomainModel([flow('f', [testidStep('a')], { signal: 's' })], null);
    expect(m.declared.signals).toEqual([]);
    expect(m.gaps.declaredUntestedSignals).toEqual([]);
  });

  it('gives an actionable summary when there are no flows', () => {
    const m = buildDomainModel([], contract({ signals: ['x'] }));
    expect(m.flowCount).toBe(0);
    expect(m.summary).toContain('No saved flows');
  });

  it('risk-ranks flows worst-first when run history is supplied', () => {
    const flows = [
      flow('clean', [testidStep('a')], { signal: 's' }), // asserted + (will pass clean)
      flow('broken', [testidStep('b')], { signal: 't' }), // asserted but last run errored
    ];
    const runs = [
      { kind: 'flow_replay', name: 'clean', status: 'pass', at: 1 },
      { kind: 'flow_replay', name: 'broken', status: 'error', at: 2 },
    ] as Parameters<typeof buildDomainModel>[2];
    const m = buildDomainModel(flows, null, runs);
    expect(m.riskRanked[0]).toBe('broken'); // failed run surfaces first
    expect(m.flows.find((f) => f.name === 'broken')?.risk?.level).toBe('high');
    expect(m.flows.find((f) => f.name === 'clean')?.risk?.level).toBe('low');
    // the summary headlines the riskiest flow to test first.
    expect(m.summary).toContain('test first: broken');
  });

  it('omits the "test first" headline when the top flow is only low risk', () => {
    const flows = [flow('clean', [testidStep('a')], { signal: 's' })];
    const runs = [{ kind: 'flow_replay', name: 'clean', status: 'pass', at: 1 }] as Parameters<
      typeof buildDomainModel
    >[2];
    expect(buildDomainModel(flows, null, runs).summary).not.toContain('test first');
  });

  it('treats a green assertion-free flow as still risky (false confidence)', () => {
    const flows = [flow('noassert', [testidStep('a')])]; // assertion-free
    const runs = [{ kind: 'flow_replay', name: 'noassert', status: 'pass', at: 1 }] as Parameters<
      typeof buildDomainModel
    >[2];
    const m = buildDomainModel(flows, null, runs);
    // passed clean, but asserts nothing → medium, not low.
    expect(m.flows[0]?.risk?.level).toBe('medium');
  });

  it('omits risk entirely when no run history is supplied', () => {
    const m = buildDomainModel([flow('f', [testidStep('a')], { signal: 's' })], null);
    expect(m.flows[0]?.risk).toBeUndefined();
    expect(m.riskRanked).toEqual([]);
  });
});
