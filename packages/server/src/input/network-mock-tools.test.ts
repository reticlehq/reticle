import { describe, expect, it } from 'vitest';
import { VisualReason } from '@syrin/iris-protocol';
import { NETWORK_MOCK_TOOLS } from './network-mock-tools.js';
import { IrisTool } from '../tools/tool-names.js';
import type { MockRule } from './network-mock.js';
import type { RealInputProvider } from './real-input.js';
import type { SessionManager } from '../session/session.js';
import type { ToolDeps } from '../tools/tools.js';

function tool() {
  const t = NETWORK_MOCK_TOOLS.find((x) => x.name === IrisTool.NETWORK_MOCK);
  if (t === undefined) throw new Error('no iris_network_mock tool');
  return t;
}

function depsWith(realInput: RealInputProvider | undefined): ToolDeps {
  const sessions: Partial<SessionManager> = {
    resolve: () => ({ url: 'http://localhost:5173/checkout' }) as never,
  };
  return { sessions: sessions as SessionManager, realInput } as unknown as ToolDeps;
}

interface MockResult {
  applied: boolean;
  count: number;
  ok?: boolean;
  reason?: string;
}

describe('iris_network_mock tool', () => {
  it('returns the no-provider envelope when nothing is driving the page', async () => {
    const res = (await tool().handler(depsWith(undefined), {
      mocks: [{ urlContains: '/api/pay', status: 500 }],
    })) as MockResult;
    expect(res.applied).toBe(false);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe(VisualReason.NO_PROVIDER);
  });

  it('applies the rules to the driven page and reports the count', async () => {
    let captured: { url: string; rules: MockRule[] } | undefined;
    const provider = {
      isAvailableFor: () => Promise.resolve(true),
      perform: () => Promise.resolve({ performed: true, center: { cx: 0, cy: 0 } }),
      setMocks: (url: string, rules: MockRule[]) => {
        captured = { url, rules };
        return Promise.resolve(true);
      },
    } as unknown as RealInputProvider;

    const res = (await tool().handler(depsWith(provider), {
      mocks: [{ urlContains: '/api/pay', method: 'POST', status: 500, abort: undefined }],
    })) as MockResult;
    expect(res.applied).toBe(true);
    expect(res.count).toBe(1);
    expect(captured?.url).toBe('http://localhost:5173/checkout');
    // undefined optional keys are stripped (exactOptionalPropertyTypes safety).
    expect(captured?.rules[0]).toEqual({ urlContains: '/api/pay', method: 'POST', status: 500 });
  });

  it('clear:true sends an empty rule set (mocking off)', async () => {
    let captured: MockRule[] | undefined;
    const provider = {
      isAvailableFor: () => Promise.resolve(true),
      perform: () => Promise.resolve({ performed: true, center: { cx: 0, cy: 0 } }),
      setMocks: (_url: string, rules: MockRule[]) => {
        captured = rules;
        return Promise.resolve(true);
      },
    } as unknown as RealInputProvider;

    const res = (await tool().handler(depsWith(provider), { clear: true })) as MockResult;
    expect(captured).toEqual([]);
    expect(res.applied).toBe(true);
    expect(res.count).toBe(0);
  });
});
