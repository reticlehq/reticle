import { describe, expect, it } from 'vitest';
import { PredicateKind } from '../verdict/consequence.js';
import { ChannelId, channelsRead } from './channel.js';
import { HelloMessageSchema } from './messages.js';
import { MessageKind, RETICLE_PROTOCOL_VERSION } from './constants/constants.js';

/**
 * Which sources of truth a claim needs to look at.
 *
 * This is the piece that was missing, and its absence is a whole class of shipped defect. Every time
 * an assertion could not be answered because this build was not watching the relevant thing, the fix
 * was to add one more boolean to the handshake, after the fact, named for that one case. There is a
 * list of them and no mechanism.
 *
 * A claim reads channels. An implementation declares the channels it can observe. If a claim reads
 * one that was not declared, that is knowable at connect time rather than after the action has been
 * spent -- which is the difference between refusing up front and reporting a result that looks like
 * evidence and is not.
 *
 * Every kind of claim must answer which channels it reads, and the table that says so is completed
 * by the compiler: leaving a kind out does not build.
 */
describe('which channels a claim reads', () => {
  it('answers for every kind of claim there is', () => {
    const silent = Object.values(PredicateKind).filter((kind) => 0 === channelsRead(kind).length);
    expect(
      silent,
      'These kinds of claim do not say what they read. A claim that reads nothing cannot be ' +
        'refused for reading something undeclared, so it would quietly bypass the whole rule.',
    ).toEqual([]);
  });

  it('reads the on-screen channel for a claim about what is on screen', () => {
    expect(channelsRead(PredicateKind.ELEMENT)).toContain(ChannelId.UI);
    expect(channelsRead(PredicateKind.TEXT)).toContain(ChannelId.UI);
  });

  it('reads the network for a claim about a request', () => {
    expect(channelsRead(PredicateKind.NET)).toEqual([ChannelId.NET]);
  });

  it('reads the log for a claim about the console', () => {
    // Named `log` rather than `console`, because a phone and a server have one and neither has a
    // browser console. The channel is the idea; `console` is one surface's word for it.
    expect(channelsRead(PredicateKind.CONSOLE)).toEqual([ChannelId.LOG]);
  });

  it('a claim made of other claims reads everything they read', () => {
    // The one that would be easy to get wrong and expensive to get wrong. If a composite reported
    // only its own channels, wrapping a claim in `allOf` would be a way to escape the rule.
    const combined = channelsRead(PredicateKind.ALL_OF);
    expect(combined).toContain(ChannelId.UI);
    expect(combined).toContain(ChannelId.NET);
    expect(combined).toContain(ChannelId.STATE);
  });

  it('offers channels no claim reads, because a realm can still have them', () => {
    // `storage` and `visual` are things an implementation either can or cannot do. Nothing asserts
    // on them directly today, and leaving them out would mean a realm had no way to say it cannot
    // take a picture.
    expect(Object.values(ChannelId)).toContain(ChannelId.STORAGE);
    expect(Object.values(ChannelId)).toContain(ChannelId.VISUAL);
  });
});

describe('the handshake carries what this build can observe', () => {
  const hello = (extra: Record<string, unknown>) => ({
    kind: MessageKind.HELLO,
    protocolVersion: RETICLE_PROTOCOL_VERSION,
    sessionId: 'demo',
    url: 'http://localhost/',
    title: 'Demo',
    adapters: [],
    ...extra,
  });

  it('accepts a build that says which channels it watches', () => {
    const parsed = HelloMessageSchema.safeParse(
      hello({ channels: [ChannelId.UI, ChannelId.NET], commands: ['snapshot', 'act'] }),
    );
    expect(parsed.success && parsed.data.channels).toEqual([ChannelId.UI, ChannelId.NET]);
    expect(parsed.success && parsed.data.commands).toEqual(['snapshot', 'act']);
  });

  it('accepts a build that says nothing, and does not read that as watching nothing', () => {
    // The back-compat rule. An older SDK sends no channels; reading that as "observes nothing"
    // would refuse every claim it could otherwise answer, which is worse than the gap it closes.
    const parsed = HelloMessageSchema.safeParse(hello({}));
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.channels).toBeUndefined();
  });

  it('refuses a channel nobody has defined', () => {
    // The list is closed on purpose: the rule that refuses undeclared channels switches on it.
    expect(HelloMessageSchema.safeParse(hello({ channels: ['telepathy'] })).success).toBe(false);
  });
});
