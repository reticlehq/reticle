/**
 * The facts a SESSION contributes to a verdict, in the shape `decideVerified` takes.
 *
 * `decideVerified` is pure and has no session, so anything it needs about the link has to be
 * threaded in. Two tools produce verdicts — `reticle_assert` and `reticle_act_and_wait` — and both
 * were threading the same fields with the same conditional-spread idiom and the same comment
 * beside it. A third fact (`versionSkew`) would have been a third copy.
 *
 * One function instead, for the ordinary reason: when a fourth fact arrives, a verdict surface that
 * learns it in one place cannot half-learn it. That failure mode is not hypothetical here — the
 * repo already records `net` assertions being discarded on one half of a surface because a filter
 * was updated on the other.
 *
 * Every field is omitted rather than defaulted when absent. An SDK too old to declare sends
 * nothing, and an empty value is a claim nobody made.
 */
/** What a session can tell a verdict. Optional throughout: absent means nobody said. */
export interface SessionVerdictFacts {
  readonly sdkVersion?: string;
  readonly versionSkew?: string;
}

/** The shape read here — structural, so a test double needs no session. */
export interface VerdictRelevantSession {
  readonly sdkVersion?: string | undefined;
  readonly versionSkew?: string | undefined;
  readonly channels?: readonly string[] | undefined;
}

export function sessionVerdictFacts(session: VerdictRelevantSession): SessionVerdictFacts {
  const facts: { sdkVersion?: string; versionSkew?: string } = {};
  // So the unread-body remedy can check it applies to THIS page.
  if (session.sdkVersion !== undefined) facts.sdkVersion = session.sdkVersion;
  /*
   * An empty string is NOT a skew. The bridge sets this only on a real mismatch, but a defaulted
   * or cleared field reaching the verdict would cost every call a `yes` it had earned — which is a
   * worse failure than the one this exists to fix.
   */
  if (session.versionSkew !== undefined && session.versionSkew.length > 0) {
    facts.versionSkew = session.versionSkew;
  }
  return facts;
}
