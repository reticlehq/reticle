/**
 * What a verdict should say the run still owes.
 *
 * Two failure modes, opposite directions. Counting the raw ledger blames a verdict for the intent it
 * just proved — measured live: an inline intent was declared, asserted and proved by one call, and
 * the result still said "1 declared intent(s) are still unproved". And reporting a bare count makes
 * a week-old backlog read exactly like a fresh omission, so the honest gap gets filtered out with
 * the noise.
 */
import { describe, expect, it } from 'vitest';
import { intentDebt } from './open-intents.js';
import type { Intent } from '@reticlehq/core/artifacts';

const NOW = Date.parse('2026-08-26T12:00:00Z');
const DAY = 86_400_000;

const intent = (id: string, declaredAt: number): Intent => ({
  id,
  statement: `do ${id}`,
  state: 'declared',
  declaredAt,
});

describe('the debt a verdict reports', () => {
  it('is zero when the ledger is empty', () => {
    expect(intentDebt([], undefined, NOW)).toEqual({ openIntentCount: 0 });
  });

  it('does NOT count the intent this verdict just proved', () => {
    const debt = intentDebt([intent('a', NOW), intent('b', NOW)], 'a', NOW);
    expect(debt.openIntentCount).toBe(1);
  });

  it('counts everything when this verdict discharged nothing', () => {
    expect(intentDebt([intent('a', NOW), intent('b', NOW)], undefined, NOW).openIntentCount).toBe(
      2,
    );
  });

  it('reports no age when nothing is left open', () => {
    expect(intentDebt([intent('a', NOW)], 'a', NOW).oldestOpenIntentAgeMs).toBeUndefined();
  });

  it('does not count a backlog older than this run', () => {
    // Measured on a real drive: every passing verdict carried "32 declared intent(s) are still
    // unproved (the oldest for 18 days)" — 142 tokens, 24.9% of the whole response, and the single
    // largest field in it. The text itself said "a backlog this old is probably not what this run
    // is about", which is the gap conceding it is noise while printing it anyway. A guard that
    // fires on every green is one people learn to skip, and then it cannot do its job on the day
    // it is right. A verdict's honesty block reports what THIS run left unproved; the standing
    // backlog belongs to reticle_context, which is where the gap's own `fix` already points.
    const debt = intentDebt([intent('ancient', NOW - 18 * DAY)], undefined, NOW);
    expect(debt.openIntentCount).toBe(0);
  });

  it('still counts a fresh one — the guard has to survive the cut', () => {
    const debt = intentDebt(
      [intent('just-now', NOW - 1000), intent('ancient', NOW - 18 * DAY)],
      undefined,
      NOW,
    );
    expect(debt.openIntentCount).toBe(1);
  });

  it('reports the age of the OLDEST fresh one, not the newest', () => {
    const debt = intentDebt(
      [intent('new', NOW - 1000), intent('older', NOW - 3 * 3600_000)],
      undefined,
      NOW,
    );
    expect(debt.oldestOpenIntentAgeMs).toBe(3 * 3600_000);
  });

  it('ignores the discharged one when finding the oldest', () => {
    // Otherwise proving the oldest intent leaves the report still quoting its age.
    const debt = intentDebt(
      [intent('older', NOW - 3 * 3600_000), intent('new', NOW - 1000)],
      'older',
      NOW,
    );
    expect(debt.oldestOpenIntentAgeMs).toBe(1000);
  });

  it('handles a ledger of one, discharged', () => {
    expect(intentDebt([intent('only', NOW)], 'only', NOW)).toEqual({ openIntentCount: 0 });
  });

  it('does not go negative on a clock that moved backwards', () => {
    // A declaredAt in the future is a machine whose clock was corrected mid-session, not a bug here.
    const debt = intentDebt([intent('future', NOW + 1000)], undefined, NOW);
    expect(debt.openIntentCount).toBe(1);
    expect(debt.oldestOpenIntentAgeMs).toBe(-1000);
  });
});
