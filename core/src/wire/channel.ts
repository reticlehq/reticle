import {
  CHANNEL_DEFAULTS,
  ChannelId,
  Independence,
  disagreementCanConvict as protocolRule,
} from '@reticlehq/openreality';
import { PredicateKind } from '../verdict/consequence.js';

/**
 * The sources of truth a verdict can be built from.
 *
 * An implementation declares which of these it can observe. A claim reads one or more of them. Put
 * those two facts together and you can tell, at the moment a connection opens, whether a claim is
 * answerable at all -- rather than finding out after the action has been spent and the moment has
 * passed.
 *
 * That ordering is the whole point. Reticle has a history of discovering a missing observation at
 * assert time and reporting a result that looked like evidence: the assertion could not be answered
 * because nothing was watching, and "nothing was watching" and "it did not happen" produced the same
 * empty answer. Each time, the fix was one more flag on the handshake named for that one case. This
 * is the mechanism those flags were each a hand-made instance of.
 *
 * Names are chosen for what the thing IS, not for what one surface calls it. A browser console, a
 * phone's log stream and a server's stdout are one channel: `log`. A realm that has no console still
 * has somewhere errors go.
 */
export { ChannelId };

/**
 * Which channels each kind of claim needs to look at.
 *
 * `Record<PredicateKind, ...>` on purpose: a new kind of claim will not compile until somebody says
 * what it reads. A kind that answered "nothing" would slip past the rule that refuses claims reading
 * undeclared channels, so silence is not an available answer.
 */
const CHANNELS_OF: Record<PredicateKind, readonly ChannelId[]> = {
  [PredicateKind.ELEMENT]: [ChannelId.UI],
  [PredicateKind.TEXT]: [ChannelId.UI],
  [PredicateKind.SIGNAL]: [ChannelId.SIGNAL],
  [PredicateKind.NET]: [ChannelId.NET],
  [PredicateKind.STATE]: [ChannelId.STATE],
  [PredicateKind.ROUTE]: [ChannelId.ROUTE],
  [PredicateKind.CONSOLE]: [ChannelId.LOG],
  // An animation is a thing on screen, observed over time. Both, because a realm that renders but
  // cannot tell you when something settled cannot answer this either.
  [PredicateKind.ANIMATION]: [ChannelId.UI, ChannelId.TIME],
  // "Has everything gone quiet" is a question about time, and about the traffic being waited on.
  [PredicateKind.SETTLED]: [ChannelId.TIME, ChannelId.NET],
  // A claim made of other claims can contain any of them. Reporting only its own channels would
  // make `allOf` a way to wrap a claim and escape the rule entirely.
  [PredicateKind.ALL_OF]: ANY_CHANNEL_A_CLAIM_CAN_READ(),
  [PredicateKind.ANY_OF]: ANY_CHANNEL_A_CLAIM_CAN_READ(),
  [PredicateKind.NOT]: ANY_CHANNEL_A_CLAIM_CAN_READ(),
};

/**
 * Every channel a claim could possibly read -- the answer for a claim built out of other claims.
 *
 * Deliberately the whole set rather than an inspection of the children. The children are not
 * available here (this is a table keyed by kind, not a function of a value), and being pessimistic
 * is the safe direction: it can refuse a composite that would in fact have been answerable, which
 * costs a false refusal. The other direction costs a false verdict.
 */
function ANY_CHANNEL_A_CLAIM_CAN_READ(): readonly ChannelId[] {
  return [
    ChannelId.UI,
    ChannelId.NET,
    ChannelId.STATE,
    ChannelId.SIGNAL,
    ChannelId.LOG,
    ChannelId.ROUTE,
    ChannelId.TIME,
  ];
}

/** The channels a claim of this kind needs to look at. */
export function channelsRead(kind: PredicateKind): readonly ChannelId[] {
  return CHANNELS_OF[kind];
}

/**
 * The independence rule, and where it lives.
 *
 * It is not defined here. It is defined in `@reticlehq/openreality`, which is the specification
 * this codebase implements, and re-exported so the rest of the repository can reach it by the name
 * it has always used.
 *
 * That direction is the point. A rule this load-bearing, defined in the product and described in
 * the spec, is two definitions of one contract -- and the two would drift the way every such pair
 * drifts, silently and in the product's favour. Defining it in the protocol and importing it here
 * means an implementation cannot quietly hold a more convenient version of the rule than the one
 * it publishes.
 */
export { Independence, CHANNEL_DEFAULTS };

/**
 * May a disagreement between these two channels be reported as a fault?
 *
 * The protocol's rule, reached by channel id rather than by descriptor, because that is the shape
 * every caller here already holds. The judgement itself is not re-implemented -- it is the
 * specification's function, applied to this repository's defaults.
 */
export function disagreementCanConvict(a: ChannelId, b: ChannelId): boolean {
  return protocolRule({ id: a, ...CHANNEL_DEFAULTS[a] }, { id: b, ...CHANNEL_DEFAULTS[b] });
}

/** How independent each channel is, in the shape this repository already reads it in. */
export const CHANNEL_INDEPENDENCE: Record<ChannelId, Independence> = Object.fromEntries(
  Object.entries(CHANNEL_DEFAULTS).map(([id, spec]) => [id, spec.independence]),
) as Record<ChannelId, Independence>;
