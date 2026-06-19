import { describe, expect, it } from 'vitest';
import { MarkAnchorStrategy, MarkStatus, type HumanMarkData } from '@syrin/iris-protocol';
import { ReviewStore } from './review-store.js';

function mark(note: string, overrides: Partial<HumanMarkData> = {}): HumanMarkData {
  return {
    note,
    anchor: 'component:Submit@src/Checkout.tsx:42',
    strategy: MarkAnchorStrategy.COMPONENT,
    label: 'Submit button',
    source: { file: 'src/Checkout.tsx', line: 42 },
    route: '/checkout',
    ...overrides,
  };
}

describe('ReviewStore', () => {
  it('adds a mark with a deterministic monotonic id and pending status, stamped with the given time', () => {
    const store = new ReviewStore();
    const a = store.add(mark('button misaligned'), 1200);
    const b = store.add(mark('wrong copy'), 1800);
    expect(a.id).toBe('m1');
    expect(b.id).toBe('m2');
    expect(a.status).toBe(MarkStatus.PENDING);
    expect(a.at).toBe(1200);
    expect(a.note).toBe('button misaligned');
    expect(a.source?.line).toBe(42);
  });

  it('lists only pending marks until one is resolved', () => {
    const store = new ReviewStore();
    const a = store.add(mark('one'), 1);
    store.add(mark('two'), 2);
    expect(store.pending().map((m) => m.note)).toEqual(['one', 'two']);
    expect(store.resolve(a.id)).toBe(true);
    expect(store.pending().map((m) => m.note)).toEqual(['two']);
  });

  it('keeps resolved marks in the full history but marks them resolved (terminal)', () => {
    const store = new ReviewStore();
    const a = store.add(mark('one'), 1);
    store.resolve(a.id);
    expect(store.all()).toHaveLength(1);
    expect(store.all()[0]?.status).toBe(MarkStatus.RESOLVED);
  });

  it('resolve is idempotent and returns false for an unknown id', () => {
    const store = new ReviewStore();
    const a = store.add(mark('one'), 1);
    expect(store.resolve(a.id)).toBe(true);
    expect(store.resolve(a.id)).toBe(false);
    expect(store.resolve('m999')).toBe(false);
  });

  it('reports pending depth without draining (a mark is consumed by resolve, not by reading)', () => {
    const store = new ReviewStore();
    store.add(mark('one'), 1);
    store.add(mark('two'), 2);
    expect(store.pendingCount()).toBe(2);
    expect(store.pending()).toHaveLength(2);
    expect(store.pendingCount()).toBe(2);
  });
});
