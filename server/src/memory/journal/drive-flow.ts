import { REPLAY_PROGRAM_VERSION, asFlowName } from '@reticlehq/core';
import type { FlowExpect, FlowName } from '@reticlehq/core';

/**
 * What this module needs a recorded step to BE, named structurally rather than imported.
 *
 * The recorder's own `RecordedStep` lives two directories away, under
 * `language/flows/recording/tape/`. Importing it made TEARDOWN reach into the recorder's internals
 * for three field names, and the reach guard's advice is the right one: the question is not whether
 * the dependency is allowed, it is whether the thing reached for is in the right place. A tape is
 * data, and this module only reads it.
 */
export interface TapeStep {
  tool: string;
  args: Record<string, unknown>;
  stable: boolean;
  expect?: FlowExpect;
  /** Recorder-internal, and the field journeys are cut on. Never written to the saved flow. */
  route?: string;
}

/** The compiled shape a flow store accepts. Structural, for the same reason as `TapeStep`. */
export interface DriveProgram {
  name: string;
  version: number;
  steps: TapeStep[];
  startPath?: string;
}

/**
 * What a session drove, saved as a replayable flow — without anybody asking for it.
 *
 * The agent-facing route to this is `record{start}` then `flow_save`, and it is a route agents do
 * not take. The corpus says so: **3 of 33 flows are mutation-testable and 6 of 112 steps declare a
 * consequence.** The engine catches 84 of the 86 bugs it structurally can, so the ceiling on this
 * product is not detection, it is how many flows exist that could go red — and every drive that is
 * never saved is a regression test that was paid for and thrown away.
 *
 * So it is not a tool and not a rule. It runs at teardown, in code, on every session.
 */

/** The one condition on saving, and the reason the whole thing is safe. */
export function carriesAnAssertion(steps: readonly TapeStep[]): boolean {
  return steps.some((step) => step.expect !== undefined);
}

/**
 * A stable name for what this session drove.
 *
 * Derived from the session id rather than a counter or a clock, for the reason `driveRunId` is:
 * teardown fires on every socket close and a reconnecting tab keeps its id, so a random name would
 * leave one journey scattered across several files, each a partial copy of the others.
 */
export function driveFlowName(sessionId: string, route?: string): FlowName {
  const safe = sessionId.replace(/[^a-zA-Z0-9-]/g, '-').slice(0, 40);
  // The route is part of the name, so two journeys in one session do not overwrite each other —
  // and so a re-drive of the same journey rewrites its own flow rather than adding a near-duplicate.
  const leg = (route ?? '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 24);
  // Minted here, not at the call site. This function is where a drive's flow name comes into
  // existence, and every character it can emit has just been forced through the safe-segment
  // replacements above — so this IS the validated boundary the brand is meant to be created at.
  // Returning `string` pushed a cast onto each caller, which is the hole `flowPath`'s parameter
  // type was added to close.
  return asFlowName(0 === leg.length ? `drive-${safe}` : `drive-${safe}-${leg}`);
}

export interface DriveFlowOutcome {
  /** The flows that were written — one per journey the session contained. */
  readonly saved?: readonly string[];
  /**
   * Steps that were driven and NOT saved because none of them declared a consequence.
   *
   * Reported rather than silently dropped. A tape with no `expect` replays green forever whatever
   * the app does, so auto-saving one manufactures a permanent pass — which is the exact failure this
   * product exists to prevent, and it would do it at a rate of one per session. Counting them is how
   * "the agent drove and proved nothing" stays visible instead of looking like nothing happened.
   */
  readonly unprovenSteps?: number;
}

/**
 * Turn this session's ambient tape into a flow, when it is worth one.
 *
 * Pure over the tape: the caller supplies it and writes the result, so the decision — save, or
 * count as unproven — is testable without a store, a session or a disk.
 */
/**
 * Cut a session's tape into journeys at ROUTE boundaries.
 *
 * A deliberate recording is one journey because somebody said where it started and where it ended.
 * An ambient tape is a whole session: sign in, go somewhere, do a thing, go somewhere else. Saved
 * whole it is one flow that begins at the login screen, and a SUITE of those fails from the second
 * one on — the app is already authenticated, so the login steps no longer apply. That hazard is
 * already written down in `bench/harness/suite-rre.mjs`, which works around it by recording its
 * flows post-login by hand; this is the same fix, done by the recorder instead of by a person.
 *
 * MEASURED before the fix: 24 of 24 auto-captured flows embedded a login step, and none carried a
 * `startPath` at all.
 *
 * The route is the boundary because it is the one the FLOW FORMAT already uses: replay navigates to
 * `startPath` before step 1, so a segment that declares its route is independent of wherever the
 * previous flow happened to leave the tab.
 */
function segmentsByRoute(steps: readonly TapeStep[]): { route?: string; steps: TapeStep[] }[] {
  const out: { route?: string; steps: TapeStep[] }[] = [];
  for (const step of steps) {
    const last = out.at(-1);
    if (last !== undefined && last.route === step.route) {
      last.steps.push(step);
      continue;
    }
    out.push({ ...(step.route === undefined ? {} : { route: step.route }), steps: [step] });
  }
  return out;
}

/** A flow per journey, so two journeys in one session are two regression tests rather than one. */
export function driveFlowsFrom(
  sessionId: string,
  tape: { steps: readonly TapeStep[]; startPath?: string } | undefined,
): { programs: DriveProgram[]; outcome: DriveFlowOutcome } {
  if (tape === undefined || 0 === tape.steps.length) return { programs: [], outcome: {} };
  const programs: DriveProgram[] = [];
  let unproven = 0;
  for (const segment of segmentsByRoute(tape.steps)) {
    if (!carriesAnAssertion(segment.steps)) {
      unproven += segment.steps.length;
      continue;
    }
    const startPath = segment.route ?? tape.startPath;
    programs.push({
      name: driveFlowName(sessionId, startPath),
      version: REPLAY_PROGRAM_VERSION,
      // The route is recorder-internal and has no business on disk — `startPath` is where the
      // on-disk flow says the same thing, in the field replay actually reads.
      steps: segment.steps.map(({ route: _route, ...step }) => step),
      ...(startPath === undefined ? {} : { startPath }),
    });
  }
  return {
    programs,
    outcome: {
      ...(0 === programs.length ? {} : { saved: programs.map((p) => p.name) }),
      ...(0 === unproven ? {} : { unprovenSteps: unproven }),
    },
  };
}
