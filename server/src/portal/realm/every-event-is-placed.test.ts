import { describe, expect, it } from 'vitest';
import { EventType } from '@reticlehq/core';
import { CHANNEL_OF_PREFIX, NO_PROTOCOL_CHANNEL, NOT_EVIDENCE } from './web-realm.js';

/**
 * Every kind of event is either evidence on a channel, or excluded with a reason.
 *
 * `observe()` turns the session's events into the observations the adjudicator reasons over, and
 * it drops any whose prefix it does not recognise. The refusal to guess is right — an
 * observation attributed to a source that did not produce it is worse than one nobody has — but
 * it made "we decided this is not evidence" and "nobody has looked at this yet" produce
 * identical behaviour: silence.
 *
 * Thirteen prefixes were falling through. Seven were unambiguously screen facts (`anim`,
 * `dialog`, `focus`, `render`, `reveal`, `scroll`, `visible`), so an animation or an opened
 * dialog was recorded by the SDK and never reached a verdict. The other six describe the TOOL —
 * its transport overflowing, its SDK failing, a person pressing pause — and excluding those is
 * correct, which is why they are now named rather than merely absent.
 *
 * This test is what stops the fourteenth arriving silently.
 */

/** Every event prefix the wire contract can produce. */
function prefixes(): string[] {
  return [...new Set(Object.values(EventType).map((t) => String(t).split('.')[0] ?? ''))]
    .filter((p) => '' !== p)
    .sort();
}

describe('every event prefix is placed', () => {
  it('finds prefixes to check, so a passing run cannot mean it read nothing', () => {
    expect(prefixes().length).toBeGreaterThan(10);
  });

  it('is either mapped to a channel or excluded with a reason', () => {
    const unplaced = prefixes().filter(
      (p) => !(p in CHANNEL_OF_PREFIX) && !(p in NOT_EVIDENCE) && !(p in NO_PROTOCOL_CHANNEL),
    );
    expect(
      unplaced,
      'these event kinds reach the session and never become evidence, and nothing says whether ' +
        'that is a decision. Map the prefix to a channel, or add it to NOT_EVIDENCE with the ' +
        'reason it describes the tool rather than the subject, or to NO_PROTOCOL_CHANNEL if it ' +
        'is real application behaviour the nine channels cannot express.',
    ).toEqual([]);
  });

  it('keeps the three categories exclusive', () => {
    // Evidence and not-evidence are exclusive; a prefix in both would make the behaviour depend
    // on which map is consulted first, which is how a rule stops being a rule.
    const inTwo = prefixes().filter(
      (p) =>
        [CHANNEL_OF_PREFIX, NOT_EVIDENCE, NO_PROTOCOL_CHANNEL].filter((m) => p in m).length > 1,
    );
    expect(inTwo).toEqual([]);
  });
});
