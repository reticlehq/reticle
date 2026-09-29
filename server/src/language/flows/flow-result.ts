import { FlowErrorCode } from '@reticlehq/core';
import { SAFE_SEGMENT_PATTERN, type ProjectId } from '@reticlehq/core';
import { FlowParseNote } from './flow-expect-grammar.js';

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
  if (FlowErrorCode.PARSE_FAILED === code && undefined !== detail) return detail;
  // The detail names both versions and the remedy, so it beats anything generic this could say.
  if (FlowErrorCode.WRONG_VERSION === code && undefined !== detail) return detail;
  switch (code) {
    case FlowErrorCode.INVALID_NAME:
      return 'invalid flow name — use a single safe segment (letters/digits/-/_), no path separators';
    case FlowErrorCode.NOT_FOUND:
      return 'no such flow on disk — run reticle_flow{action:"list"} to see saved flows';
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
