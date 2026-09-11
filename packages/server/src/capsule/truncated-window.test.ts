/**
 * A window the buffer trimmed cannot state an absolute about what did NOT happen.
 *
 * The field case this exists for: an app rewrote one localStorage key thousands of times a minute,
 * the no-op writes starved the ring buffer (`held: 2000, dropped: 70482`), and the capsule for that
 * window reported `net.total: 0`, `stateDiffs: []` and `state "cad" never changed` — while a POST
 * that had returned 200 inside that same window carried the entire root cause in its body. The agent
 * read the zero and was one step from reporting "clicking Accept fires no network request", which
 * sends a developer to the click handler instead of to the payload the server rejected.
 *
 * `honesty.integrity.losses` already carried `buffer_loss` and it was not enough: the fields an agent
 * reads to form a verdict are these, and a bare `0` several levels above a nested flag reads as a
 * fact. The absolute and the caveat must not be separable.
 */
import { describe, expect, it } from 'vitest';
import { ConsequenceKind, EventType, type ReticleEvent } from '@reticlehq/core';
import { buildDivergenceCapsule } from './capsule.js';
import { firstDivergence, type ExpectedLink } from './divergence.js';
import { causalSummary } from './causal-summary.js';

const NOTHING: readonly ReticleEvent[] = [];
const STATE_LINK: ExpectedLink = { kind: ConsequenceKind.STATE, name: 'cad' };
const NET_LINK: ExpectedLink = { kind: ConsequenceKind.NET, urlContains: '/apply', status: 200 };
const SIGNAL_LINK: ExpectedLink = { kind: ConsequenceKind.SIGNAL, name: 'applied' };

describe('a clean window still speaks plainly', () => {
  it.each([
    [STATE_LINK, 'never changed'],
    [NET_LINK, 'no request to /apply'],
    [SIGNAL_LINK, 'never fired'],
  ])('says what did not happen when nothing was lost', (link, phrase) => {
    expect(firstDivergence([link], NOTHING)?.observed).toContain(phrase);
  });

  it('carries no truncation marker', () => {
    expect(causalSummary(NOTHING)).not.toHaveProperty('truncated');
  });
});

describe('a truncated window reports a floor, not a total', () => {
  it.each([STATE_LINK, NET_LINK, SIGNAL_LINK])(
    'never claims a consequence did not happen',
    (link) => {
      const observed = firstDivergence([link], NOTHING, true)?.observed ?? '';
      expect(observed).toContain('truncated');
      for (const absolute of ['never changed', 'never fired', 'no request to']) {
        expect(observed, `"${absolute}" is a claim this window cannot support`).not.toContain(
          absolute,
        );
      }
    },
  );

  it('marks the summary whose counts an agent reads first', () => {
    const capsule = buildDivergenceCapsule([STATE_LINK], NOTHING, true);
    expect(capsule.summary.truncated, 'net.total: 0 must not read as a fact').toBe(true);
    expect(capsule.summary.net.total).toBe(0);
  });

  it('still names the link that diverged — the caveat qualifies it, it does not hide it', () => {
    expect(firstDivergence([STATE_LINK], NOTHING, true)?.expected).toEqual(STATE_LINK);
  });

  it('does not caveat a link that was answered by a surviving event', () => {
    const responded: ReticleEvent[] = [
      {
        type: EventType.NET_REQUEST,
        t: 1,
        data: { url: 'https://api.test/apply', status: 500 },
      } as unknown as ReticleEvent,
    ];
    const observed = firstDivergence([NET_LINK], responded, true)?.observed ?? '';
    expect(observed, 'a 500 that WAS seen is evidence, truncation or not').toContain('500');
    expect(observed).not.toContain('truncated');
  });
});
