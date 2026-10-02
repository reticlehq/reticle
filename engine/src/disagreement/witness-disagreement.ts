/**
 * Two independent observers, and what it means when they disagree.
 *
 * Every channel a realm declares is, in the end, the subject describing itself. The DOM says the
 * order saved because the app wrote that on the screen; the network says so because the app made
 * the call. When an app lies to itself — an optimistic update never committed, a write that
 * returned 200 and rolled back — every channel inside it repeats the lie consistently, and no
 * amount of evidence from in there ever settles it. The database is not in there.
 *
 * So this is not an inference and it is not a heuristic: it is two observers that cannot have
 * caused each other's reading, disagreeing. Nothing else this engine produces carries that weight,
 * which is why the `Witness` SPI omits every method that could act — an implementer who CAN act
 * through the same object eventually will, and its evidence is worthless the moment it might have
 * caused what it reports.
 *
 * The asymmetry here is the entire safety property. A witness that could not be reached proves
 * NOTHING and must never read as agreement: "I could not check" and "I checked and it was fine" are
 * opposite answers, and collapsing them is precisely how a verification that never happened gets
 * reported as one that did.
 */

export const WitnessOutcome = {
  /** The app and an observer outside it do not agree about whether the effect happened. */
  DISAGREES: 'witness-disagrees',
  /** The outside observer could not be consulted, so nothing was settled either way. */
  UNREACHABLE: 'witness-unreachable',
} as const;
export type WitnessOutcome = (typeof WitnessOutcome)[keyof typeof WitnessOutcome];

export interface WitnessReading {
  /** Did the app assert the effect happened — a success signal, a 2xx, a rendered confirmation. */
  readonly appClaims: boolean;
  /** What the outside observer saw. `undefined` means it was not consulted successfully. */
  readonly witnessSaw: boolean | undefined;
  /** Why the witness could not be consulted, when it could not be. */
  readonly unreachable?: string;
}

export interface WitnessFinding {
  readonly kind: WitnessOutcome;
  readonly because: string;
  /** True when nothing was settled. An inconclusive finding is never a pass and never a failure. */
  readonly inconclusive?: boolean;
}

export function witnessDisagreement(reading: WitnessReading): WitnessFinding | undefined {
  if (reading.witnessSaw === undefined) {
    return {
      kind: WitnessOutcome.UNREACHABLE,
      because: `the outside observer could not be consulted (${reading.unreachable ?? 'no reason given'}), so nothing here is settled — this is not agreement, and it is not a failure of the app`,
      inconclusive: true,
    };
  }
  if (reading.appClaims === reading.witnessSaw) return undefined;
  return {
    kind: WitnessOutcome.DISAGREES,
    because: reading.appClaims
      ? 'the app reported success and an observer outside it did not see the effect — the app is the only thing claiming this happened'
      : 'an observer outside the app saw the effect while the app claimed nothing — a side effect the interface is hiding, or one it never meant to cause',
  };
}
