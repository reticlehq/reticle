import { describe, expect, it } from 'vitest';
import {
  CHANNEL_INDEPENDENCE,
  ChannelId,
  Independence,
  disagreementCanConvict,
} from '../wire/channel.js';
import {
  CONTRADICTION_CHANNELS,
  ContradictionKind,
  contradictionCanConvict,
  isAdvisory,
  tierOfFinding,
  FindingTier,
} from './findings.js';

/**
 * The independence rule, enforced instead of believed.
 *
 * Every contradiction in this codebase happens to compare an app-side claim against the network,
 * which is exactly what the rule requires -- and nothing anywhere checked it. The rule lived in the
 * specification as prose and in the judgement of whoever added the last kind. That is the shape of
 * the MCAS mistake: the two-of-three doctrine was right, and nothing in the system knew that both
 * votes came off one vane.
 *
 * So the pairing is data and this reads it. The value is not in what it catches today -- it catches
 * nothing today, which is the point -- but in the kind somebody adds in a year that sets the screen
 * against the store and calls the disagreement a bug.
 */

describe('a disagreement can only convict when a channel outside the action saw it', () => {
  it('refuses two channels the action itself produced', () => {
    // The screen renders from the store. An app wrong about what it did is wrong on both, together.
    expect(disagreementCanConvict(ChannelId.UI, ChannelId.STATE)).toBe(false);
    expect(disagreementCanConvict(ChannelId.SIGNAL, ChannelId.UI)).toBe(false);
    expect(disagreementCanConvict(ChannelId.ROUTE, ChannelId.VISUAL)).toBe(false);
  });

  it('accepts a pair with one side outside the action', () => {
    expect(disagreementCanConvict(ChannelId.UI, ChannelId.NET)).toBe(true);
    expect(disagreementCanConvict(ChannelId.SIGNAL, ChannelId.NET)).toBe(true);
    // Both outside it is fine too: a status line and the body under it are the server's answer,
    // and neither of them was decided by the click.
    expect(disagreementCanConvict(ChannelId.NET, ChannelId.NET)).toBe(true);
  });

  it('has an answer for every channel, so a new one cannot arrive undeclared', () => {
    for (const channel of Object.values(ChannelId)) {
      expect(Object.values(Independence)).toContain(CHANNEL_INDEPENDENCE[channel]);
    }
  });
});

describe('every contradiction that can convict compares independent channels', () => {
  it('names the channels of every kind', () => {
    for (const kind of Object.values(ContradictionKind)) {
      expect(CONTRADICTION_CHANNELS[kind], `${kind} does not say what it compares`).toBeDefined();
    }
  });

  /**
   * The one that matters. A kind that forces `no` is asserting a fault in the app, and it may only
   * do that when something outside the app's own actuation path disagreed.
   *
   * Absence-derived kinds downgrade to `unknown` and advisory kinds decide nothing, so neither
   * convicts -- but both are still required to name their channels above, because a kind promoted
   * out of those tiers later must not arrive here unexamined.
   */
  it('never convicts on two channels the action produced', () => {
    const convicting = Object.values(ContradictionKind).filter(
      (kind) => tierOfFinding(kind) === FindingTier.OBSERVED && !isAdvisory(kind),
    );
    expect(convicting.length).toBeGreaterThan(0);
    const violations = convicting.filter((kind) => !contradictionCanConvict(kind));
    expect(
      violations,
      'These force a `no` from two channels the action itself produced. That is the app ' +
        'disagreeing with its own reporting, which is worth saying and is not proof the action ' +
        'failed. Report it at a tier that does not convict, or find an independent channel.',
    ).toEqual([]);
  });
});
