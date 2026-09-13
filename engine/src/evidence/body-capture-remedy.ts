/**
 * What to tell a caller whose assertion needs response bodies, given what the connected SDK can do.
 *
 * The remedy used to be one fixed sentence naming `captureNetworkBodies`. Reported from the field:
 * six verdicts came back `unknown`/`outcome_unread` advising that setting against a pinned
 * `@reticlehq/react` from before it existed. The reporter set the env var, restarted, got the
 * identical message, and worked it out by elimination.
 *
 * The daemon is TOLD the page's SDK version at HELLO and threw it away after computing skew. Nothing
 * new has to be observed to say the true thing — it only has to be kept.
 *
 * Same class as the version-skew remedy that named a React package on Vue projects: remedy text that
 * does not check whether it applies. A wrong remedy is worse than none, because it is followed.
 */

/** The release that introduced `captureNetworkBodies` — see the browser observer's history. */
export const BODY_CAPTURE_MIN_VERSION = '2.4.0';

/**
 * Compare two dotted versions numerically.
 *
 * String comparison inverts exactly where it hurts: `'2.10.0' < '2.4.0'` lexically, so a NEWER SDK
 * would be told it is too old and the working remedy withheld. A prerelease suffix is dropped rather
 * than parsed — `2.13.0-rc.1` is 2.13 for this question, and nothing here needs finer.
 */
function isAtLeast(version: string, minimum: string): boolean {
  const parts = (v: string): number[] =>
    v
      .split('-')[0]
      ?.split('.')
      .map((n) => Number.parseInt(n, 10) || 0) ?? [];
  const have = parts(version);
  const want = parts(minimum);
  for (let i = 0; i < Math.max(have.length, want.length); i += 1) {
    const a = have[i] ?? 0;
    const b = want[i] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}

/** The sentence naming the setting — only ever produced for an SDK that HAS it. */
const ENABLE_IT =
  'Turn it on where your app calls connect(): `reticle.connect({ captureNetworkBodies: true })`, ' +
  'or for the Vite plugin `reticle({ captureNetworkBodies: true })` / VITE_RETICLE_CAPTURE_BODIES=1. ' +
  'Then re-run the action.';

/**
 * The remedy for this session, or the honest statement that there is none.
 *
 * An UNKNOWN version is treated as capable. A hand-wired connect reports none, and guessing "too
 * old" there would hide a working fix from someone who could have used it; the opposite guess costs
 * one wasted read. The asymmetry decides it.
 */
export function bodyCaptureRemedy(sdkVersion: string | undefined): string {
  if (sdkVersion !== undefined && !isAtLeast(sdkVersion, BODY_CAPTURE_MIN_VERSION)) {
    return (
      `this page's SDK is ${sdkVersion}, and body capture needs ${BODY_CAPTURE_MIN_VERSION} or ` +
      'newer — the setting does not exist in your version, so there is nothing to switch on. ' +
      'Upgrade the SDK, or assert on something else this session can see.'
    );
  }
  return ENABLE_IT;
}

/** Clause names that can only be answered from a recorded body. */
const BODY_CLAUSE_FIELDS = ['bodyContains', 'requestBodyContains'] as const;

/** Does this predicate, or anything nested in it, ask about a body? */
function asksAboutBody(predicate: unknown): boolean {
  if (null === predicate || 'object' !== typeof predicate) return false;
  const node = predicate as Record<string, unknown>;
  if (BODY_CLAUSE_FIELDS.some((f) => node[f] !== undefined)) return true;
  // The reported shape is an `allOf` carrying route + console + the net clause that needs bodies.
  // Checking only the top level would miss every realistic call.
  const nested = node['predicates'] ?? node['predicate'];
  if (Array.isArray(nested)) return nested.some(asksAboutBody);
  return asksAboutBody(nested);
}

/**
 * Refuse a body clause the session cannot answer, BEFORE the action is spent.
 *
 * Reported: an `act_and_wait` matched the right call and returned `verified: "no"` with "a matching
 * call with no recorded body", because that project's `connect()` does not pass
 * `captureNetworkBodies` — and the reporter could not change it, since it was not their project's
 * config to edit for an unrelated verification task. The action bought nothing that was not knowable
 * in advance, and on a drive that mutates state an action is not always repeatable. That is what
 * makes this a pre-flight rather than a better failure message.
 *
 * Refuses ONLY on a DECLARED `captureBodies: false`. An SDK too old to announce the setting sends
 * nothing, and refusing on silence would break every session predating the announcement for a clause
 * many of them satisfy — the same asymmetry that makes an unknown VERSION count as capable.
 */
export function bodyClauseRefusal(
  predicate: unknown,
  session: { captureBodies?: boolean | undefined; sdkVersion?: string | undefined },
): string | undefined {
  if (false !== session.captureBodies) return undefined;
  if (!asksAboutBody(predicate)) return undefined;
  return (
    'this assertion reads a request/response BODY, and this session is not recording them — it ' +
    `would fail whatever the app did. Nothing ran, so no action was spent. ${bodyCaptureRemedy(session.sdkVersion)}`
  );
}
