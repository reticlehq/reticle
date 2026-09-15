import { z } from 'zod';
import { ChannelId, type ChannelDescriptor } from './vocabulary/channel.js';

/**
 * Who implements this, and what they are entitled to claim.
 *
 * A single pass mark quietly sorts implementations by architecture, and only the one the spec was
 * written against scores full marks. That is the WS-* failure: a specification you cannot
 * implement without the author's product is a product with a spec-shaped cover.
 *
 * So conformance comes in profiles, and an implementation earns the highest it can answer for. An
 * out-of-process verifier driving a debugging protocol reaches `effect` honestly and can never
 * reach `in-realm`, because that needs code inside the subject's own world. It is not a worse
 * implementation. It is a different one, and it should say so and still be conformant.
 */

export const Profile = {
  /** The floor: what happens at the boundary, and what got logged. Reachable from outside. */
  EFFECT: 'effect',
  /** And the subject's own state and announcements. Needs code inside its world. */
  IN_REALM: 'in-realm',
  /** And what is on screen: addressing things and checking they are there. */
  SURFACE: 'surface',
} as const;
export type Profile = (typeof Profile)[keyof typeof Profile];

/** Profiles from the least demanding upward, which is the order they are earned in. */
export const PROFILES_IN_ORDER: readonly Profile[] = [
  Profile.EFFECT,
  Profile.IN_REALM,
  Profile.SURFACE,
];

/**
 * The channels each profile requires.
 *
 * A profile is a claim about what you can SEE, not only about what you answered. An
 * implementation that answers every scenario correctly while declaring nothing has demonstrated
 * that it can say "I could not tell", which is necessary and nowhere near sufficient.
 */
export const CHANNELS_REQUIRED: Record<Profile, readonly ChannelId[]> = {
  [Profile.EFFECT]: [ChannelId.NET, ChannelId.LOG],
  [Profile.IN_REALM]: [ChannelId.NET, ChannelId.LOG, ChannelId.STATE, ChannelId.SIGNAL],
  [Profile.SURFACE]: [
    ChannelId.NET,
    ChannelId.LOG,
    ChannelId.STATE,
    ChannelId.SIGNAL,
    ChannelId.UI,
  ],
};

export const ImplementationSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  /** Where it runs, for a reader deciding whether it is relevant to them. */
  platform: z.string().min(1),
  /** The profile it claims. Whether it EARNED it is the conformance suite's answer, not its own. */
  claims: z.nativeEnum(Profile),
  /** Where to find it. */
  homepage: z.string().optional(),
});
export type Implementation = z.infer<typeof ImplementationSchema>;

/**
 * The highest profile these channels could support.
 *
 * Only the channel half — the scenario half is the conformance suite's. Answering it here lets an
 * implementation discover at startup that it is claiming a profile it cannot reach, rather than
 * discovering it from a failing scoreboard.
 */
export function profileFromChannels(declared: readonly ChannelDescriptor[]): Profile | undefined {
  const have = new Set(declared.map((c) => c.id));
  let earned: Profile | undefined;
  for (const profile of PROFILES_IN_ORDER) {
    if (!CHANNELS_REQUIRED[profile].every((c) => have.has(c))) break;
    earned = profile;
  }
  return earned;
}

/** Channels an implementation must add to reach the profile it claims. Empty means it qualifies. */
export function channelsMissingFor(
  claimed: Profile,
  declared: readonly ChannelDescriptor[],
): readonly ChannelId[] {
  const have = new Set(declared.map((c) => c.id));
  return CHANNELS_REQUIRED[claimed].filter((c) => !have.has(c));
}
