/**
 * The bus keeps its one promise: a hook cannot break or slow a verification.
 *
 * Every test here is that promise from a different angle, because it is the property that decides
 * whether hooks are safe to turn on at all. A notification script must not be able to turn a passing
 * check into a failing one.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { HookEvent, type HookPayload } from '@reticlehq/core/hooks';
import { emitHook, hookListenerCount, onHook, resetHooks } from './hook-bus.js';

afterEach(() => {
  resetHooks();
  vi.restoreAllMocks();
});

const verdict = (): HookPayload => ({
  event: HookEvent.VERDICT,
  at: '2026-01-01T00:00:00.000Z',
  tool: 'reticle_assert',
  verified: 'yes',
});

describe('the hook bus', () => {
  it('delivers a payload to a listener for that event', () => {
    const seen: HookPayload[] = [];
    onHook(HookEvent.VERDICT, (p) => seen.push(p));
    emitHook(verdict());
    expect(seen).toHaveLength(1);
    expect(seen[0]?.event).toBe(HookEvent.VERDICT);
  });

  it('delivers nothing to a listener for a DIFFERENT event', () => {
    const seen: HookPayload[] = [];
    onHook(HookEvent.BUG_FOUND, (p) => seen.push(p));
    emitHook(verdict());
    expect(seen).toEqual([]);
  });

  it('delivers every event to a listener that asked for all of them', () => {
    const seen: HookPayload[] = [];
    onHook(undefined, (p) => seen.push(p));
    emitHook(verdict());
    expect(seen).toHaveLength(1);
  });

  // THE test. A throwing hook is a user's broken script, and it must cost the verdict nothing.
  it('does not throw when a listener throws, and still reaches the others', () => {
    const seen: string[] = [];
    onHook(HookEvent.VERDICT, () => {
      throw new Error('the user script is broken');
    });
    onHook(HookEvent.VERDICT, () => seen.push('second'));
    expect(() => emitHook(verdict())).not.toThrow();
    expect(seen, 'a broken listener must not swallow the ones after it').toEqual(['second']);
  });

  it('reports a broken listener ONCE, not once per event', () => {
    const logged: unknown[] = [];
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => logged.push(a));
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => logged.push(a));
    onHook(HookEvent.VERDICT, () => {
      throw new Error('same failure every time');
    });
    for (let i = 0; i < 25; i += 1) emitHook(verdict());
    expect(logged.length, 'a laptop with a typo would otherwise fill the log').toBeLessThan(3);
  });

  it('drops a payload that does not match its schema rather than throwing at the caller', () => {
    const seen: HookPayload[] = [];
    onHook(HookEvent.VERDICT, (p) => seen.push(p));
    const malformed = { event: HookEvent.VERDICT, at: '2026-01-01T00:00:00.000Z' } as HookPayload;
    expect(() => emitHook(malformed)).not.toThrow();
    expect(seen, 'an invalid payload is our bug, and it must not become the caller').toEqual([]);
  });

  it('strips a field the payload does not declare, so nothing rides along', () => {
    const seen: HookPayload[] = [];
    onHook(HookEvent.VERDICT, (p) => seen.push(p));
    // Deliberately not a HookPayload: the point is that a caller spreading a wider object cannot
    // smuggle its extra fields out. Cast through `unknown`, because it genuinely is not one.
    emitHook({ ...verdict(), pairingToken: 'secret' } as unknown as HookPayload);
    expect(seen).toHaveLength(1);
    expect(Object.hasOwn(seen[0] ?? {}, 'pairingToken')).toBe(false);
  });

  it('stops delivering after unsubscribe', () => {
    const seen: HookPayload[] = [];
    const off = onHook(HookEvent.VERDICT, (p) => seen.push(p));
    emitHook(verdict());
    off();
    emitHook(verdict());
    expect(seen).toHaveLength(1);
  });

  it('emits to nobody without complaint — the normal case is no hooks at all', () => {
    expect(hookListenerCount(HookEvent.VERDICT)).toBe(0);
    expect(() => emitHook(verdict())).not.toThrow();
  });
});
