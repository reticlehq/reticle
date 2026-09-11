/**
 * The one line that tells an agent it can push back — worded for what just happened.
 *
 * Feedback is the highest-yield channel this product has: **14 reports over two days produced
 * roughly 11 of the fixes in 2.6.0**, against ~6,100 numeric events that produced a funnel which
 * turned out to be broken. Prose from an agent at the moment of friction beats any structured field
 * we could add.
 *
 * It reached those 14 through a standing instruction in the MCP handshake — paid once at connect.
 * The gap that leaves is the agent who hits something mid-task and is concentrating on the problem
 * rather than on remembering that a feedback tool exists.
 *
 * So: invite at the moment of friction, and vary the wording. A fixed string repeated forty times
 * is invisible by call five; a line that names what just went wrong is read because it is about the
 * thing the agent is already looking at. ~12 tokens against a ~4,546 tok/turn surface.
 *
 * Every invite is counted (`feedbackPrompted`). If `feedback_submitted ÷ feedbackPrompted` stays
 * flat, this is decoration and should be deleted — instrumenting our own nudge is the difference
 * between a designed system and a hope.
 */

/** What just happened, as far as the chokepoint can tell. Ordered most specific first. */
export const FrictionKind = {
  /** A tool that does not exist — the agent named a capability it expected us to have. */
  UNKNOWN_TOOL: 'unknown_tool',
  /** A verdict came back `unknown`: we drove the app and could not tell what happened. */
  UNKNOWN_VERDICT: 'unknown_verdict',
  /** The same tool, several times in a row. */
  REPEATING: 'repeating',
  /** The tool refused or errored. */
  REFUSED: 'refused',
} as const;
export type FrictionKind = (typeof FrictionKind)[keyof typeof FrictionKind];

/**
 * Runs of one tool before it counts as being stuck.
 *
 * Three, matching the verdict nudge: `reticle_act` led the field data at 110 consecutive-repeat
 * runs, and a run of three is where a deliberate retry becomes a loop.
 */
const REPEAT_INVITE_AT = 3;

const LINES: Record<FrictionKind, string> = {
  [FrictionKind.UNKNOWN_TOOL]:
    'no such tool — reticle_feedback tells us what you expected it to do, which is how it gets built',
  [FrictionKind.UNKNOWN_VERDICT]:
    'Reticle could not tell what happened here. If you expected otherwise, reticle_feedback. An ' +
    'unknown verdict is our defect, not yours',
  [FrictionKind.REPEATING]:
    'stuck on the same call? reticle_feedback — say what you were trying to do and it gets fixed',
  [FrictionKind.REFUSED]:
    'if that diagnosis was wrong or unhelpful, reticle_feedback — error messages are a product ' +
    'surface and we fix the ones that fail',
};

/**
 * Which friction, if any, this result represents.
 *
 * Deliberately reads only what the chokepoint already has: no handler changes, and nothing here can
 * see app data.
 */
export function frictionOf(facts: {
  unknownTool: boolean;
  verifiedUnknown: boolean;
  repeatRun: number;
  errored: boolean;
  /** Did this call produce a verdict? A verdict is progress, and progress is not being stuck. */
  producedVerdict: boolean;
}): FrictionKind | undefined {
  if (facts.unknownTool) return FrictionKind.UNKNOWN_TOOL;
  if (facts.verifiedUnknown) return FrictionKind.UNKNOWN_VERDICT;
  // Repetition is only friction when it is repetition WITHOUT PROGRESS. Found by driving the Tauri
  // smoke app: three consecutive SUCCESSFUL act_and_wait calls, each producing a verdict, were
  // answered with "stuck on the same call?" — nagging the exact loop this release exists to
  // encourage. A verdict is progress.
  if (facts.repeatRun >= REPEAT_INVITE_AT && !facts.producedVerdict) return FrictionKind.REPEATING;
  if (facts.errored) return FrictionKind.REFUSED;
  return undefined;
}

/** The line for a friction kind. */
export function inviteFor(kind: FrictionKind): string {
  return LINES[kind];
}
