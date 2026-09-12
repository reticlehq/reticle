/**
 * A verdict taken over a skewed link is not a verdict, and must say so where the agent is looking.
 *
 * Version skew causes SILENT action failures, not merely the "may behave in ways neither side
 * reports" the warning describes. Reported on Radix controls: `act_and_wait` returned
 * `dispatched: true`, `settled: true`, sometimes `domMutatedWithin: 12-40ms`, while React state never
 * changed — confirmed by reading `aria-checked`/`data-state` straight afterwards. Eight attempts and
 * three interaction strategies before the reporter suspected skew at all; after converging versions
 * the identical sequence worked first try.
 *
 * Their own account of the cost: *"the false-positive dispatch confirmation is what cost the most
 * time — I trusted `dispatched: true, domMutatedWithin: Nms` as real signal for a long time before
 * suspecting the skew banner."*
 *
 * The banner existed. It rode on `reticle_sessions` and `reticle_lease` — so the one surface an
 * agent reads on EVERY call was the one that did not mention it. This puts it on the health envelope,
 * which is spliced onto act and assert results, next to the `dispatched`/`settled` fields it
 * contradicts.
 */

import { describe, expect, it } from 'vitest';
import { healthEnvelope } from './session-health.js';
import type { Session } from './session.js';

const sessionWith = (over: Record<string, unknown>): Session =>
  ({
    health: () => ({ lastSeenMs: 20, throttled: false, focused: true, ...over }),
    throttled: () => false,
  }) as unknown as Session;

describe('a skewed session says so on every verdict it touches', () => {
  it('surfaces the skew on the envelope act and assert already carry', () => {
    const envelope = healthEnvelope(sessionWith({ versionSkew: 'daemon 2.13.1, page 2.11.0' }));
    expect(
      JSON.stringify(envelope),
      'the one surface read on every call must mention it',
    ).toContain('2.11.0');
  });

  it('warns, because the fields beside it read as success', () => {
    const envelope = healthEnvelope(sessionWith({ versionSkew: 'daemon 2.13.1, page 2.11.0' }));
    expect(
      envelope.warning,
      'dispatched/settled look clean on a skewed link — the contradiction has to be stated',
    ).toBeTypeOf('string');
  });

  it('stays silent on a matched session', () => {
    // The envelope is omitted entirely when nothing is wrong, and skew must not change that.
    expect(healthEnvelope(sessionWith({}))).toEqual({});
  });
});
