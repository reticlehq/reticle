/**
 * What `reticle gate` means by its exit code.
 *
 * Split out of the handler because two different readers depend on it and they want opposite
 * things. CI wants any problem to be a failure. A Stop hook — the layer that makes verification
 * unskippable — wants to block a real regression and NOT block a project that has simply not
 * recorded a flow yet, which is every project on its first day.
 *
 * `NOTHING_TO_CHECK` stays non-zero deliberately. The gate exits non-zero over an empty suite
 * because "nothing was checked" and "everything passed" are indistinguishable from the outside,
 * and that reasoning does not stop being true just because a second caller appeared.
 */
export const GateExit = {
  /** Affected flows were checked and hold. */
  PASS: 0,
  /** Something is actually wrong: an affected flow with no passing artifact, a downgraded
   * assertion, deleted coverage. A caller should stop here. */
  FAIL: 1,
  /** The gate ran and had nothing to judge — no flows recorded. Non-zero, but not a regression. */
  NOTHING_TO_CHECK: 2,
  /** The platform knows a flow that passed before and is broken now: `reticle runs regression`'s code. */
  REGRESSION: 3,
} as const;

/**
 * The gate's code once the platform has been asked about regressions: a known one fails the build
 * with `reticle runs regression`'s code, whatever the local answer was, so the gate is the one
 * command CI needs. `undefined` (not linked, or the platform did not answer) changes nothing.
 */
export function gateExitWith(
  local: number,
  regressed: number | undefined,
  /** The platform the project is linked to refused its credential: the gate fails closed. */
  refused = false,
): number {
  if (regressed !== undefined && 0 < regressed) return GateExit.REGRESSION;
  return refused && GateExit.PASS === local ? GateExit.FAIL : local;
}

/**
 * Said when the linked platform refused the key. A CI pipeline whose key was revoked stayed green
 * and silent: the gate lost the platform's regression report and the only trace was a log line.
 */
export function msgGateRefused(why: string): string {
  return (
    `Reticle gate: ${why.replace(/\.+$/, '')}. The gate could not ask the platform this project is linked to for its ` +
    'regression report, so it fails closed rather than pass without it.'
  );
}

/** Said when the gate had no saved flows to judge, so exit 2 does not read as the change failing. */
export const MSG_GATE_NO_FLOWS =
  'Reticle gate: no saved flows here, so there was nothing to check; this is not a failure of this ' +
  'change. Record one by driving the app with reticle_act_and_wait, or run ' +
  '`reticle verify <url> --explore`, then run the gate again.';

/**
 * Said when the platform knows a regression, outside a hook. Exit 3 printed only the JSON log, whose
 * coverage field still read "no flows recorded — nothing was checked", so nothing a person read
 * said "regression".
 */
export function msgGateRegression(broken: readonly unknown[]): string {
  const names = broken.map((entry) => {
    if ('string' === typeof entry) return entry;
    const record =
      'object' === typeof entry && null !== entry ? (entry as Record<string, unknown>) : {};
    const name = record['flowName'] ?? record['name'];
    const was = record['previousStatus'];
    const now = record['currentStatus'];
    const flow = 'string' === typeof name ? name : 'a flow';
    return 'string' === typeof was && 'string' === typeof now ? `${flow} (${was} → ${now})` : flow;
  });
  return (
    `Reticle gate: regression — ${names.join(', ')} passed before and fails now on the platform. ` +
    'See `reticle runs regression`.'
  );
}
