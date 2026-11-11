import {
  FlowErrorCode,
  NO_SUCH_FLOW,
  ReplayStatus,
  ReticleTool,
  Verified,
  VerifiedReason,
  type FlowReplayResult,
} from '@reticlehq/core';
import { SAFE_SEGMENT_PATTERN, type ProjectId } from '@reticlehq/core';
import { z } from 'zod';
import { FlowParseNote } from './flow-expect-grammar.js';
import { isAmbient } from './recording/tape/recordings.js';

/** Discriminated result so callers never branch on free strings. */
export type FlowResult<T> =
  { ok: true; value: T } | { ok: false; code: FlowErrorCode; detail?: string };

/**
 * A project id that is safe to put in a path, or nothing.
 *
 * An unsafe or absent value collapses to `undefined` — the flat, global store — so a malformed id
 * can never escape `.reticle/flows/`. The store defends the disk boundary itself rather than
 * trusting whatever arrived in a session's HELLO.
 *
 * Held to one SEGMENT, not to a flow name. A project id becomes a DIRECTORY; a flow name is an
 * ADDRESS, and since composites began naming sub-journeys as `onboarding/signup` its pattern has
 * allowed separators. Validating a directory name with the address guard let a page choose how deep
 * under `.reticle/` Reticle wrote — not an escape, since neither pattern admits `..` or a leading
 * separator, but the page naming directories all the same.
 *
 * A FILTER, not a mint. It answers "is this id safe on disk", never "is this id a project" — a
 * session id passes `SAFE_SEGMENT_PATTERN` just as cleanly, so minting the brand here would launder
 * the exact confusion `ProjectId` exists to catch. The brand arrives already attached, from HELLO
 * or from `.reticle.json`; see `ProjectId` in core.
 *
 * The narrowing said it out loud and nobody was listening: `isValidFlowName` narrows its argument to
 * `FlowName`, for a value that is a project. The sibling guards for session and run ids have used
 * the segment pattern since that widening, and `id-guards-are-not-flow-names.test.ts` exists to
 * hold the distinction — this is the fourth id joined into a path, and the one that file missed.
 */
export const safeProjectId = (projectId?: ProjectId): ProjectId | undefined =>
  projectId !== undefined && SAFE_SEGMENT_PATTERN.test(projectId) ? projectId : undefined;

/** Map a structured FlowErrorCode to a legible one-line message for the agent. */
export function flowErrorMessage(code: FlowErrorCode, detail?: string): string {
  if (FlowErrorCode.PARSE_FAILED === code && undefined !== detail) {
    return detail;
  }
  // The detail names both versions and the remedy, so it beats anything generic this could say.
  if (FlowErrorCode.WRONG_VERSION === code && undefined !== detail) {
    return detail;
  }
  switch (code) {
    case FlowErrorCode.INVALID_NAME:
      return 'invalid flow name — use a single safe segment (letters/digits/-/_), no path separators';
    case FlowErrorCode.NOT_FOUND:
      return `${NO_SUCH_FLOW} — run reticle_flow{action:"list"} to see saved flows`;
    case FlowErrorCode.PARSE_FAILED:
      return FlowParseNote.MALFORMED;
    case FlowErrorCode.NO_RECORDING:
      return 'no compiled recording by that name — record one (reticle_record{action:"start"|"stop"}) first';
    // Never "regenerate it": the file is intact and the reader is the wrong one. Telling somebody
    // to rewrite an undamaged flow is the failure this code was split out of PARSE_FAILED to stop.
    case FlowErrorCode.WRONG_VERSION:
      return 'this flow file was written in a different flow-file format — the file is not damaged, this Reticle cannot read that version. Upgrade or downgrade Reticle rather than editing the flow';
    case FlowErrorCode.STEP_NOT_FOUND:
      return (
        detail ?? 'the step to resume at is not in this flow — pass a 0-based index or a step id'
      );
  }
}

/**
 * A replay as one check of the session that ran it: held when it replayed clean, failed when a step
 * failed, undecided when it drifted or its flow asserts nothing. A session whose only work was a
 * failing replay ended "nothing was checked" beside the replay's own failure.
 */
export function replayVerdictEffect(
  name: string,
  status: ReplayStatus,
  assertsNothing: boolean,
): { claim: string; verified: Verified; declaredBeforeActing: true; grade: string } {
  let verified: Verified = Verified.UNKNOWN;
  if (ReplayStatus.OK === status && !assertsNothing) {
    verified = Verified.YES;
  } else if (ReplayStatus.ERROR === status) {
    verified = Verified.NO;
  }
  return {
    claim: `the flow "${name}" replays and its checks hold`,
    verified,
    declaredBeforeActing: true,
    grade: REPLAY_GRADE,
  };
}

/** The grade a replay's check is recorded with. */
const REPLAY_GRADE = 'flow';

/** True when a channel disagreed on a step of the replay, or across its steps. */
function channelsDisagreed(replay: FlowReplayResult): boolean {
  if (replay.steps.some((step) => 0 < (step.contradictions?.length ?? 0))) {
    return true;
  }
  return 0 < (replay.crossStep?.length ?? 0);
}

/** The clause behind an `ok` replay. Only a flow that can fail, with no channel disagreeing, is proved. */
function okReplayReason(replay: FlowReplayResult): VerifiedReason {
  if (replay.unverifiable !== undefined) {
    return VerifiedReason.NOTHING_DECLARED;
  }
  if (channelsDisagreed(replay)) {
    return VerifiedReason.CONTRADICTED;
  }
  return VerifiedReason.PROVED;
}

/**
 * The clause that decided a replay, from the set every verdict tool uses (#2205).
 *
 * A replay answered with a status only, so a caller that reads the reason got nothing. A reason the
 * replay path already named is kept: that path knows a narrower cause than its status. The `switch`
 * has no default, so a new `ReplayStatus` does not compile until it has a reason.
 */
export function replayVerifiedReason(replay: FlowReplayResult): VerifiedReason {
  if (replay.verifiedReason !== undefined) {
    return replay.verifiedReason;
  }
  switch (replay.status) {
    case ReplayStatus.OK:
      return okReplayReason(replay);
    // An anchor or a declared consequence that was there when the flow was saved is not there now.
    case ReplayStatus.DRIFT:
      return VerifiedReason.ASSERTION_FAILED;
    // The flow did not load, an action did not run, or the run could not start: nothing was graded.
    case ReplayStatus.ERROR:
    case ReplayStatus.UNVERIFIABLE:
      return VerifiedReason.INCONCLUSIVE;
  }
}

/** The replay with its reason set: what `reticle_flow_replay` answers with. */
export function withReplayReason(replay: FlowReplayResult): FlowReplayResult {
  return { ...replay, verifiedReason: replayVerifiedReason(replay) };
}

/**
 * The output fields that say how far a replay's status can be trusted. A field that the schema
 * does not declare is removed from a validating profile's response, so both are declared here.
 */
export const REPLAY_TRUST_OUTPUT = {
  unverifiable: z
    .object({ reason: z.string() })
    .optional()
    .describe(
      'Set on an ok replay that cannot fail: the flow asserts no observable consequence, so it passes even when the feature is broken. Same reason reticle_verify{action:"flows"} reports.',
    ),
  verifiedReason: z
    .nativeEnum(VerifiedReason)
    .optional()
    .describe(
      'The clause that decided this replay, from the set reticle_assert and reticle_act_and_wait use: proved | nothing_declared | contradicted | assertion_failed | inconclusive | observation_lost. Read it to choose the next step.',
    ),
};

/** Record a replay as one check of the session that ran it. A session double without a journal is skipped. */
export function noteReplayCheck(
  session: {
    recordAction?: (tool: string, args: Record<string, unknown>, effect?: unknown) => string;
  },
  name: string,
  status: ReplayStatus,
  assertsNothing: boolean,
): void {
  session.recordAction?.(
    ReticleTool.FLOW_REPLAY,
    { flowName: name },
    replayVerdictEffect(name, status, assertsNothing),
  );
}

/**
 * The active recording a refused `reticle_flow_save` was most likely about: the one it named, or
 * the only one running when it named none and nothing is stopped yet.
 */
// A running recording has no compiled program yet, so a save refusal names it (#1551).
export function stillRecording(
  active: readonly string[],
  name: string,
  explicitName: string | undefined,
  held: readonly string[],
): string | undefined {
  if (active.includes(name) && !isAmbient(name)) {
    return name;
  }
  // The ambient tape is the daemon's own, never one the agent started, so it is neither named nor
  // counted: with a named recording beside it, that one is still the only candidate.
  const opened = active.filter((recording) => !isAmbient(recording));
  if ((explicitName === undefined || 0 === explicitName.length) && 0 === held.length) {
    return 1 === opened.length ? opened[0] : undefined;
  }
  return undefined;
}

export function stillRecordingMessage(recording: string): string {
  return (
    `'${recording}' is still recording, and flow_save only saves a stopped recording. ` +
    `Stop it first with reticle_record{action:"stop", recordingName:"${recording}"}, then save again.`
  );
}
