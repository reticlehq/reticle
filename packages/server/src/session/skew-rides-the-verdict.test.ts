/**
 * A verdict taken over a skewed link is not a verdict, and must say so (#812).
 *
 * Version skew between the page SDK and the daemon does not merely risk odd behaviour: it produced
 * `dispatched: true`, `settled: true`, `domMutatedWithin: 12-40ms` on Radix controls whose React
 * state never changed. Eight attempts across three interaction strategies went by before the
 * reporter suspected skew, because the one surface an agent reads on every call said nothing.
 *
 * The pre-existing `version_skew` nudge is one-shot and rides `reticle_sessions` / `reticle_lease`.
 * These tests pin the other half: while skew holds, every act/assert result carries the
 * qualification, on the same envelope the throttled warning already uses.
 */
import { describe, expect, it } from 'vitest';
import type { CommandResult } from '@reticlehq/core';
import { UNSCRIPTABLE_TAB_RECOMMENDATION } from '@reticlehq/core';
import { healthEnvelope } from './session-health.js';
import { createFakeSession } from './fake-session.js';
import type { Session } from './session.js';

const SKEW = 'page SDK 2.13.1, daemon 2.14.0';

function sessionWith(options: { skew?: string; throttled?: boolean } = {}): Session {
  const throttled = true === options.throttled;
  const command = (): Promise<CommandResult> =>
    Promise.resolve({ kind: 'command_result', id: 'c', ok: true, result: {} });
  const health = throttled
    ? {
        lastSeenMs: 0,
        throttled: true,
        focused: false,
        recommendation: UNSCRIPTABLE_TAB_RECOMMENDATION,
      }
    : { lastSeenMs: 0, throttled: false, focused: true };
  const session = createFakeSession(
    {
      elapsed: () => 0,
      command,
      health: () => health,
      bufferHealth: () => ({ total: 0, dropped: 0 }),
      throttled: () => throttled,
    },
    { url: 'http://localhost:5173/app' },
  );
  if (options.skew !== undefined) session.versionSkew = options.skew;
  return session;
}

describe('skew is on the verdict, not only on the session listing', () => {
  it('says nothing on a healthy, converged session', () => {
    // The envelope stays empty when there is nothing to report: a healthy session must not pay
    // tokens on every call, which is why absence means healthy.
    expect(healthEnvelope(sessionWith())).toEqual({});
  });

  it('qualifies a result taken over a skewed link', () => {
    const envelope = healthEnvelope(sessionWith({ skew: SKEW }));
    expect(envelope.skewSuspected).toBeDefined();
    expect(envelope.skewSuspected).toContain(SKEW);
  });

  it('says the result is not a verdict, not merely that something may misbehave', () => {
    // The reporter trusted dispatched/settled for eight attempts. A hedge would not have stopped
    // that; the sentence has to say the fields above it cannot be believed.
    const note = healthEnvelope(sessionWith({ skew: SKEW })).skewSuspected ?? '';
    expect(note).toContain('NOT a verdict');
    expect(note).toContain('dispatched');
  });

  it('rides EVERY call while the skew holds, unlike the one-shot nudge', () => {
    const session = sessionWith({ skew: SKEW });
    const calls = [1, 2, 3].map(() => healthEnvelope(session).skewSuspected);
    expect(calls.every((c) => c !== undefined)).toBe(true);
  });

  it('does not displace the throttled warning when both hold', () => {
    const envelope = healthEnvelope(sessionWith({ skew: SKEW, throttled: true }));
    expect(envelope.warning, 'the throttle warning still leads').toBeDefined();
    expect(envelope.session?.throttled).toBe(true);
    expect(envelope.skewSuspected, 'and the skew rides alongside it').toBeDefined();
  });

  it('still reports an unhealthy session when there is no skew', () => {
    const envelope = healthEnvelope(sessionWith({ throttled: true }));
    expect(envelope.session?.throttled).toBe(true);
    expect(envelope.skewSuspected).toBeUndefined();
  });
});
