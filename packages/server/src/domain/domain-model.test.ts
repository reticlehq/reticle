import { describe, expect, it } from 'vitest';
import {
  FLOW_FILE_VERSION,
  AnchorKind,
  type CapabilitiesContract,
  type FlowExpect,
  type FlowFile,
  type FlowStep,
} from '@syrin/iris-protocol';
import { IrisTool } from '../tools/tool-names.js';
import { buildDomainModel } from './domain-model.js';

function testidStep(value: string): FlowStep {
  return { tool: IrisTool.ACT, anchor: { kind: AnchorKind.TESTID, value } };
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
});
