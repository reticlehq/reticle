import {
  type PredicateKind,
  type ReticleVerificationRun,
  type VerdictStatus,
  type Verified,
} from '@reticlehq/core';

/**
 * Turning what a run recorded into a document somebody outside this repository can read.
 *
 * The run file is ours. It is shaped for the tools that write it, it changes when they change, and
 * it carries fields nobody else has a use for. That is exactly right for a file we produce and
 * consume, and no basis at all for asking a stranger to depend on it.
 *
 * So this is one pure function and the internal shapes stay as they are. If nobody ever adopts the
 * format, the cost of having tried is this file.
 *
 * The rule it follows: **never say more than the run can back up.** Anything the run did not record
 * is left out rather than filled in, because a default is a claim, and a claim nobody checked is the
 * precise thing this whole system exists to stop producing. An empty string where a commit should be
 * is not "no commit" to a reader -- it is a commit whose name is empty.
 */

/** What this document is, said in the document, so a reader never has to guess from its shape. */
export const OPENREALITY_ARTIFACT_KIND = 'openreality.verification';

/** The version of the specification this document follows. See openreality/SPEC.md. */
export const OPENREALITY_ARTIFACT_VERSION = 1;

/** One thing that was claimed, and what checking it came out as. */
export interface ExportedCheck {
  /** What was claimed, as the person or agent wrote it. */
  readonly claim: string;
  /** Which source of truth answering it required. */
  readonly reads: PredicateKind;
  /**
   * Was the claim written down before the action, or after it?
   *
   * The difference between a check and a rationalisation, and the first of the four things that
   * make this document something other than an ordinary test report.
   */
  readonly declaredBeforeActing?: boolean;
  /**
   * What kind of evidence bought the answer.
   *
   * A green has a price. Flattening a presence check and a network observation into one word lets
   * the cheap evidence pass for the dear evidence.
   */
  readonly grade?: string;
  /**
   * What could not be seen while this was being checked.
   *
   * The property with no prior art anywhere: every other test report is silent about its own blind
   * spots. An empty list says nothing was hidden. Absent says nobody looked.
   */
  readonly couldNotSee?: readonly string[];
  /**
   * What it came out as: `yes`, `no`, `unknown` or `no-fault`.
   *
   * This was a boolean, on the reasoning that a check is one observation and the four-valued
   * verdict belongs to the run. That reasoning was wrong in the way this project exists to catch:
   * a boolean has no way to say "I could not tell", so checks that said it were dropped on the way
   * out, and the document a stranger reads was silent about our own blind spots while listing the
   * app's. The specification says a verdict is one of four things; this is that verdict.
   */
  readonly verdict: Verified;
}

/** What was verified, and about what. */
export interface ExportedArtifact {
  readonly kind: typeof OPENREALITY_ARTIFACT_KIND;
  readonly specVersion: typeof OPENREALITY_ARTIFACT_VERSION;
  /** Which run this came from, so an export can be traced to what produced it. */
  readonly runId: string;
  /** What was being verified. */
  readonly subject: {
    readonly name: string;
    readonly commit?: string;
    readonly url?: string;
  };
  /** How long the run took, in milliseconds. Included because a verdict without one is a claim
   * about an unbounded stretch of time, and the specification says a verdict is about a window. */
  readonly durationMs: number;
  /**
   * Which round of source edits this evidence belongs to.
   *
   * Evidence gathered before the change under test is true about the old code. Nothing else in this
   * document catches that, and nothing else in the industry records it.
   */
  readonly editEpoch?: number;
  readonly checks: readonly ExportedCheck[];
  /**
   * The run's own summary over its checks.
   *
   * A different question from a check's verdict and so a different vocabulary, deliberately:
   * `partial` says some held and some did not, which is not something a single claim can be.
   */
  readonly summary: {
    readonly status: VerdictStatus;
    /** Why, in the words the run recorded. Never re-worded here. */
    readonly because: readonly string[];
    /** Which check this is about, when it is about one, so a later document can correct it. */
    readonly checkId?: string;
    /**
     * The earlier verdict this replaces, written `<runId>#<checkId>`.
     *
     * Present only on a correction, and the document it names is not withdrawn. Both stand, so
     * "we always knew" stops being expressible.
     */
    readonly supersedes?: string;
  };
}

/**
 * Every check, including the ones nothing could decide.
 *
 * This used to drop those, because the exported outcome was a boolean and neither `true` nor
 * `false` is true of them. Dropping was the least-wrong option available and it was still wrong:
 * a reader comparing the document to their session found verdicts simply absent, and a reader who
 * did not compare read a shorter, cleaner list than the evidence supports.
 */
function exportedChecks(run: ReticleVerificationRun): ExportedCheck[] {
  const decided: ExportedCheck[] = [];
  for (const check of run.checks) {
    decided.push({
      claim: check.predicate,
      reads: check.kind,
      verdict: check.status,
      // Spread, so a value the run did not record leaves the key out rather than writing a
      // comfortable default. `declaredBeforeActing: false` says the claim came afterwards; absent
      // says nobody recorded which, and a reader must be able to tell those apart.
      ...(check.declaredBeforeActing === undefined
        ? {}
        : { declaredBeforeActing: check.declaredBeforeActing }),
      ...(check.grade === undefined ? {} : { grade: check.grade }),
      ...(check.couldNotSee === undefined ? {} : { couldNotSee: check.couldNotSee }),
    });
  }
  return decided;
}

/**
 * Export a run.
 *
 * Pure: the same run in, the same document out, every time. No clock is read -- stamping "exported
 * at" would make two exports of one run differ, and a document that changes when nothing changed is
 * not evidence of anything.
 */
export function toArtifact(run: ReticleVerificationRun): ExportedArtifact {
  return {
    kind: OPENREALITY_ARTIFACT_KIND,
    specVersion: OPENREALITY_ARTIFACT_VERSION,
    runId: run.runId,
    subject: {
      name: run.project.name,
      // Spread rather than assigned, so an absent value leaves the key out entirely instead of
      // writing `undefined` into it. See the rule at the top of this file.
      ...(run.project.commit === undefined ? {} : { commit: run.project.commit }),
      ...(run.project.previewUrl === undefined ? {} : { url: run.project.previewUrl }),
    },
    durationMs: run.durationMs,
    ...(run.editEpoch === undefined ? {} : { editEpoch: run.editEpoch }),
    checks: exportedChecks(run),
    summary: {
      status: run.verdict.status,
      because: run.verdict.reasons,
      // Spread, per the rule at the top: a correction that is not one must not carry an empty
      // pointer, which a reader would take for a citation nothing resolves.
      ...(run.verdict.checkId === undefined ? {} : { checkId: run.verdict.checkId }),
      ...(run.verdict.supersedes === undefined ? {} : { supersedes: run.verdict.supersedes }),
    },
  };
}
