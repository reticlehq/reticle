import {
  OVP_VERSION,
  type Action,
  type ActionReceipt,
  type Anomaly,
  type ChannelDescriptor,
  type Claim,
  type Coverage,
  type Evidence,
  type Grade,
  type VerificationRun,
  type Verdict,
  type Window,
} from 'open-verification';

/**
 * The document a human and an agent both read, and a third party can re-check.
 *
 * `renderReport` produces something legible; this produces something CHECKABLE. The difference is
 * the whole reason both exist: a report is a thing you have to trust the producer for, and a
 * `VerificationRun` is a document somebody who has never heard of us can parse, re-adjudicate and
 * disagree with.
 *
 * It is also the artifact both views are built from. A human reading a rendered report and an
 * agent reading a verdict must never be looking at different evidence, because two parties
 * disagreeing about what happened is the failure this whole design is shaped to prevent.
 *
 * PURE, with the clock injected. The same drives assemble the same document, which is what lets
 * two of them be diffed and what makes it safe to attach to a build.
 */

/** Who produced these runs. A named constant, because a wire string is never a free string. */
const VERIFIER_NAME = '@reticlehq/cli-realm';

/** One claim, driven and adjudicated. Everything a verdict needs to be re-checked. */
export interface DriveOutcome {
  readonly claim: Claim;
  readonly action: Action;
  readonly receipt: ActionReceipt;
  readonly window: Window;
  readonly channels: readonly ChannelDescriptor[];
  readonly evidence: readonly Evidence[];
  readonly coverage: Coverage;
  readonly anomalies: readonly Anomaly[];
  readonly adjudication: {
    readonly verdict: Verdict;
    readonly grade?: Grade;
    readonly ground: string;
    readonly reasons: readonly string[];
  };
}

export interface RunInput {
  readonly id: string;
  /**
   * The verifier's own version, supplied rather than written down here.
   *
   * It was a literal, and a literal in SOURCE is outside everything that stamps a release:
   * `set-version.mjs` reaches manifests, docs.json, SKILL frontmatter and the crate files, and
   * nothing it has ever done touches a string inside a `.ts`. So every run this realm emitted
   * would have gone on claiming the previous version, for as long as nobody looked -- the exact
   * shape of the crate that sat at 0.1.0 for months while its publish step printed "nothing to
   * do" and exited green.
   *
   * A caller reads it from the package manifest, which set-version does reach.
   */
  readonly verifierVersion: string;
  readonly drives: readonly DriveOutcome[];
  readonly startedAt: number;
  readonly endedAt: number;
}

/**
 * Assemble the run.
 *
 * Note what is NOT here: a summary field. `outcomeOf` computes the outcome from the verdicts, and
 * a producer that could write its own would be able to write one its verdicts do not support.
 * That is the single lie this document must not be able to tell, so the shape simply does not
 * offer somewhere to tell it.
 */
export function buildRun(input: RunInput): VerificationRun {
  const first = input.drives[0];
  return {
    ovp: OVP_VERSION,
    id: input.id,
    verifier: {
      name: VERIFIER_NAME,
      version: input.verifierVersion,
      // No profile claimed, and that is the honest answer rather than a missing one. The
      // conformance floor names `net` and `log`, and this realm's consequence-grade channel is
      // the filesystem, so it reaches no profile as the table is written. Profiles score an
      // implementation; they do not gate one, and a run is worth reading either way.
    },
    subject: first?.window.subject ?? { surface: 'x-cli', instance: 'unknown' },
    channels: [...(first?.channels ?? [])],
    witnesses: [],
    intents: [],
    claims: input.drives.map((d) => d.claim),
    constraints: [],
    actions: input.drives.map((d) => d.action),
    receipts: input.drives.map((d) => d.receipt),
    windows: input.drives.map((d) => d.window),
    evidence: input.drives.flatMap((d) => [...d.evidence]),
    coverage: input.drives.map((d) => d.coverage),
    anomalies: input.drives.flatMap((d) => [...d.anomalies]),
    verdicts: input.drives.map((d, index) => ({
      id: `v${String(index + 1)}`,
      claim: d.claim.id,
      window: d.window.id,
      verdict: d.adjudication.verdict,
      // Carried, never inferred. A `yes` whose grade is absent is a green nobody can price, and
      // the difference between "something was on screen" and "the subject provably did it" is
      // the difference this artifact exists to keep legible.
      ...(d.adjudication.grade === undefined ? {} : { grade: d.adjudication.grade }),
      reasons: [...d.adjudication.reasons],
      evidence: d.evidence.map((e) => e.observation.id),
      anomalies: [...d.anomalies],
      at: d.window.closedAt ?? d.window.openedAt,
    })),
    violations: [],
    repairs: [],
    startedAt: input.startedAt,
    endedAt: input.endedAt,
  };
}
