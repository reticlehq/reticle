import { describe, expect, it } from 'vitest';
import { resolveTargetRef } from './resolve-target.js';

describe('resolving a target query to one ref', () => {
  it('returns the ref when exactly one element matches', () => {
    const r = resolveTargetRef([{ ref: 'e3', role: 'button', name: 'Sign in', visible: true }]);
    expect(r).toEqual({ kind: 'ref', ref: 'e3' });
  });

  /**
   * The whole point of the one-call path is that it cannot silently act on the wrong thing. Picking
   * the first match would produce a verdict about an element the author never named, and the verdict
   * would look correct because it describes what it acted on.
   */
  it('REFUSES an ambiguous target rather than picking one', () => {
    const r = resolveTargetRef([
      { ref: 'e3', role: 'button', name: 'Save', visible: true },
      { ref: 'e9', role: 'button', name: 'Save', visible: true },
    ]);
    expect(r.kind).toBe('error');
    if (r.kind !== 'error') return;
    expect(r.message).toContain('2 elements');
    expect(r.message, 'names the candidates so the caller can narrow').toContain('e3');
    expect(r.message).toContain('e9');
    expect(r.message, 'offers the way out').toContain('ref');
  });

  it('ignores hidden duplicates, which would otherwise fake ambiguity', () => {
    const r = resolveTargetRef([
      { ref: 'e3', role: 'button', name: 'Save', visible: true },
      { ref: 'e9', role: 'button', name: 'Save', visible: false },
    ]);
    expect(r).toEqual({ kind: 'ref', ref: 'e3' });
  });

  it('falls back to hidden matches when nothing is visible, so the message is about the right thing', () => {
    const r = resolveTargetRef([{ ref: 'e7', role: 'button', name: 'Save', visible: false }]);
    expect(r).toEqual({ kind: 'ref', ref: 'e7' });
  });

  it('says nothing matched, and says no verdict is possible', () => {
    const r = resolveTargetRef([]);
    expect(r.kind).toBe('error');
    if (r.kind !== 'error') return;
    expect(r.message).toContain('no element');
    expect(r.message.toLowerCase()).toContain('no verdict');
  });

  it('refuses a match with no ref instead of acting on undefined', () => {
    expect(resolveTargetRef([{ role: 'button', visible: true }]).kind).toBe('error');
  });
});
