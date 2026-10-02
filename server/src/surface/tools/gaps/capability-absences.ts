/**
 * What this session CANNOT see, said up front.
 *
 * An agent asking "what can I do here?" gets the app's testable surface: its testids, signals, stores
 * and flows. That answers what the app OFFERS. It says nothing about what the instrumentation in the
 * page is switched off from watching.
 *
 * So an agent could plan a verification around a request body, spend an action on it, and only then
 * be told that this session does not record bodies. The refusal it eventually meets is good and
 * arrives before the action is spent. It is still late: the plan was already built around something
 * that was never going to work, and the agent paid to find out.
 *
 * The rule this follows, and the reason for the `false !==` checks below: an absence is only reported
 * when the page DECLARED the feature off. An older SDK sends nothing at all, and reading silence as
 * "off" would announce a missing capability to every session that predates the announcement and can
 * satisfy the clause perfectly well. Silence means unknown, never no.
 */

/** One thing this session cannot do, why it matters, and how to turn it on. */
export interface CapabilityAbsence {
  /** Stable name, so an agent can branch on it without reading prose. */
  capability: string;
  /** What is lost. Written for whoever has to decide what to do instead. */
  meaning: string;
  /** How to get it back, or why you might not want to. */
  remedy: string;
}

/** The parts of a session this reads. Narrow on purpose, so a fake in a test is three fields. */
export interface CapabilityFacts {
  captureBodies?: boolean | undefined;
  sourceMapping?: boolean | undefined;
}

/**
 * Every capability this session has declared switched OFF.
 *
 * Empty when nothing is declared off, which is the normal case. Callers omit the field entirely when
 * it is empty rather than sending `[]`, so that an empty answer keeps meaning "nothing is missing"
 * instead of becoming a line on every healthy response that people learn to skip.
 */
export function capabilityAbsences(session: CapabilityFacts): CapabilityAbsence[] {
  const absences: CapabilityAbsence[] = [];

  if (false === session.captureBodies) {
    absences.push({
      capability: 'network-bodies',
      meaning:
        'request and response bodies are not recorded, so an assertion that reads one cannot be ' +
        'answered here and will be refused before it spends an action',
      remedy:
        "pass captureBodies: true to connect() in this app's Reticle setup, then reload the page. " +
        'Bodies can carry personal data, so this is off unless a project asks for it.',
    });
  }

  if (false === session.sourceMapping) {
    absences.push({
      capability: 'source-mapping',
      meaning:
        'elements do not carry a source stamp, so a failing verdict can say what went wrong but ' +
        'not which file and line to open',
      remedy:
        'this is often deliberate: some renderers reject unknown DOM attributes, so setups that ' +
        'need it switch the stamp off on purpose. Verdicts stay correct without it.',
    });
  }

  return absences;
}
