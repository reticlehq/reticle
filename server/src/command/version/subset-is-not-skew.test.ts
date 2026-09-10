import { describe, expect, it } from 'vitest';
import { describeSkew } from './version-skew.js';

/**
 * An implementation that speaks PART of the contract is compatible, not broken.
 *
 * The fingerprint is a hash over the whole vocabulary, so it can say "same" or "different" and
 * nothing else. That is fine while every implementation is this repository's own and implements
 * everything. It stops being fine the moment somebody else writes one.
 *
 * A phone SDK that implements eighteen of the event types and eight of the commands is doing the
 * CORRECT thing -- there is no touch equivalent of a console error, and no reason to pretend. Under
 * a hash comparison it produces a different fingerprint and is therefore reported as skewed on every
 * single tool call, forever, with a message telling its author to upgrade something that is not
 * wrong. There is no version of that SDK which is not "skewed".
 *
 * Subset is the only relationship a third-party implementation will ever have with us. So the
 * comparison has to be structural: a peer that declares a subset of what we know is compatible, and
 * skew means the peer named something we have never heard of.
 */

const SELF = { version: '3.0.0', contract: 'aaaa1111' };
const PEER = (extra: Record<string, unknown>) => ({
  what: 'the page',
  version: '3.0.0',
  contract: 'bbbb2222',
  fix: 'upgrade it',
  ...extra,
});

describe('a peer that speaks part of the contract', () => {
  it('is silent when it declares a subset of what we know', () => {
    const skew = describeSkew(
      PEER({
        contractParts: { commands: ['snapshot'], events: ['dom_mutation'], actions: ['click'] },
      }),
      {
        ...SELF,
        contractParts: {
          commands: ['snapshot', 'act'],
          events: ['dom_mutation', 'net_request'],
          actions: ['click', 'fill'],
        },
      },
    );
    expect(
      skew,
      'A peer implementing part of the contract is doing the right thing. Warning about it on ' +
        'every call is how a real warning gets ignored.',
    ).toBeUndefined();
  });

  it('is silent even though the fingerprints differ', () => {
    // The whole point. Under the old rule these two hashes disagreeing was the entire test, and a
    // subset can never produce a matching hash.
    const skew = describeSkew(
      PEER({
        contract: 'totally-different',
        contractParts: { commands: ['snapshot'], events: [], actions: [] },
      }),
      {
        ...SELF,
        contractParts: {
          commands: ['snapshot', 'act'],
          events: ['dom_mutation'],
          actions: ['click'],
        },
      },
    );
    expect(skew).toBeUndefined();
  });

  it('speaks up when the peer names something we have never heard of', () => {
    // The real mismatch, and now the only one. A name we do not know means the peer was built
    // against a contract this daemon does not have -- which is a genuine "one of us is stale".
    const skew = describeSkew(
      PEER({ contractParts: { commands: ['snapshot', 'teleport'], events: [], actions: [] } }),
      { ...SELF, contractParts: { commands: ['snapshot', 'act'], events: [], actions: [] } },
    );
    expect(skew).toBeDefined();
    expect(skew).toContain('teleport');
  });

  it('falls back to comparing fingerprints when the peer sent no parts', () => {
    // Back-compat: every SDK in the field sends a fingerprint and no parts. They must keep getting
    // exactly the behaviour they get today, including the warning when the hashes really differ.
    expect(describeSkew(PEER({}), SELF)).toBeDefined();
    expect(describeSkew(PEER({ contract: SELF.contract }), SELF)).toBeUndefined();
  });
});
