/**
 * The ReticleVerificationRun artifact — the stable, versioned contract a host platform (an OEM/design
 * partner) or CI consumes after Reticle verifies a generated/edited app. It is assembled from data Reticle
 * already produces (flow replay, asserts, evidence timeline, source mapping); this file only defines
 * the WIRE/DISK shape so it can be frozen under semver. Persisted at `.reticle/runs/<runId>.json` and
 * returned by the programmatic Replay/Verify API.
 *
 * Conventions match the rest of `@reticlehq/core`: enums are `as const` objects narrowed with
 * `z.nativeEnum`, timestamps are epoch-ms NUMBERS (the clock is injected — never read inside pure
 * logic), no `any` (opaque evidence is `z.unknown`), and every domain string is a named constant.
 */

import { z } from 'zod';
import { PredicateKind } from './consequence.js';
import { Verified } from './verified-constants.js';

/** Schema version stamped into every run file so a reader can reject/upgrade old artifacts. */
export const RUN_FILE_VERSION = 3;

/**
 * The version this artifact used before checks were recorded in the assertion vocabulary.
 *
 * Version 1 spelled a network check `network` where an assertion says `net`, and had a `layout` kind
 * nothing could produce. Files already on disk are still read: the two old spellings are translated
 * on the way in, so a stored run from before this change opens rather than reading as empty. Empty
 * is the dangerous outcome -- it looks like a run that found nothing.
 */
const RUN_FILE_VERSION_BEFORE_ONE_VOCABULARY = 1;

/**
 * The version this artifact used before a check could say it was undetermined.
 *
 * Version 2 recorded a check as `pass` or `fail` and nothing else, so a check nobody could evaluate
 * had no spelling and was dropped on the way in. That is the exact loss this whole system exists to
 * prevent, committed by our own artifact: "I could not see" left the document silently, and a reader
 * counting checks counted our blind spots as the app's clean bill of health.
 *
 * Files already on disk are still read. `pass` and `fail` translate to `yes` and `no`, which is what
 * they always meant.
 */
const RUN_FILE_VERSION_BEFORE_UNDETERMINED_CHECKS = 2;

/** The old spelling of each check outcome, for reading a version 2 file. */
const OLD_CHECK_STATUS_SPELLING: Readonly<Record<string, string>> = {
  pass: Verified.YES,
  fail: Verified.NO,
};

/** The old spelling of each check kind, for reading a version 1 file. */
const OLD_CHECK_KIND_SPELLING: Readonly<Record<string, string>> = {
  network: PredicateKind.NET,
  // `layout` was never produced by anything, so a file cannot contain one. Mapped to the nearest
  // truthful thing rather than dropped, so a hand-written file does not fail to open.
  layout: PredicateKind.ELEMENT,
};

/**
 * A run's identity, branded so it can't be confused with another id (e.g. a flow name) that also feeds
 * path helpers. The schema brands on parse; mint a fresh one with asRunId at a trusted/validated point.
 */
export const RunIdSchema = z.string().brand<'RunId'>();
export type RunId = z.infer<typeof RunIdSchema>;
/** Mint a RunId from a raw string — call only at a validated boundary (e.g. behind isValidRunId). */
export const asRunId = (value: string): RunId => value as RunId;

/**
 * Retention bound for .reticle/runs/ so disk stays bounded over a long-running pipeline. Pruned
 * oldest-first only once the count exceeds RUN_RETENTION + RUN_RETENTION_SLACK, then back down to
 * RUN_RETENTION — so the O(n) prune is amortized (≈ once per SLACK writes), not paid on every write.
 */
export const RUN_RETENTION = 500;
export const RUN_RETENTION_SLACK = 100;

/** Structured outcome when reading a run file fails (never thrown). Mirrors ProjectReadError. */
export const RunReadError = {
  MISSING: 'run-missing', // no .reticle/runs/<id>.json on disk
  MALFORMED: 'run-malformed', // present but not valid JSON / fails schema
} as const;
export type RunReadError = (typeof RunReadError)[keyof typeof RunReadError];

/** The overall verdict on a verification run. PARTIAL = some flows passed, some failed/were gated. */
export const VerdictStatus = {
  PASS: 'pass',
  FAIL: 'fail',
  PARTIAL: 'partial',
  /**
   * Nothing was proved either way -- no flow and no check produced an outcome, so there is nothing
   * to pass and nothing to fail.
   *
   * This is deliberately NOT a pass. A run that checked nothing and a run that checked everything
   * successfully are different facts, and flattening them into one word is how a green light comes
   * to mean "we did not look". It matches how a single action is already judged, where "could not
   * tell" has always been its own answer.
   */
  UNKNOWN: 'unknown',
} as const;
export type VerdictStatus = (typeof VerdictStatus)[keyof typeof VerdictStatus];

/** Per-flow outcome inside a run. HEALED = a drifted anchor was consequence-verified and rebound. */
export const RunFlowStatus = {
  PASS: 'pass',
  FAIL: 'fail',
  SKIPPED: 'skipped',
  HEALED: 'healed',
} as const;
export type RunFlowStatus = (typeof RunFlowStatus)[keyof typeof RunFlowStatus];

/**
 * The kind of standalone assertion captured outside a flow.
 *
 * This is `PredicateKind` -- the vocabulary assertions are written in -- and not a second list.
 * There used to be one here, and the two had already drifted: the same idea was spelled `net` in an
 * assertion and `network` in the artifact, and `layout` existed here and in nothing anybody could
 * write, so it could never be recorded. Re-exported under the old name so the places that read it
 * from this file still can.
 */
export { PredicateKind };

/**
 * What a check came out as.
 *
 * `Verified` and not a second list. There used to be a binary one here, and the two had already
 * done what two vocabularies for one thing always do: a verdict was four-valued everywhere it was
 * decided and two-valued the moment it was written down, so `unknown` and `no-fault` -- the two the
 * specification says make the other two mean anything -- could not be recorded at all.
 *
 * Re-exported so the places that read it from this file still can.
 */
export { Verified };

/**
 * A risk surface a changed file / observed behaviour touches. The governance seed: a host can gate
 * a deploy when a high-severity surface is hit. Mirrors the surfaces real AI-app-builder incidents
 * cluster around (production data loss, auth/payment/RLS mistakes).
 */
export const RiskSurface = {
  AUTH: 'auth',
  PAYMENT: 'payment',
  DB: 'db',
  MIGRATION: 'migration',
  RLS: 'rls',
  SECRETS: 'secrets',
  DESTRUCTIVE: 'destructive',
  EXTERNAL: 'external',
} as const;
export type RiskSurface = (typeof RiskSurface)[keyof typeof RiskSurface];

/** Severity of a flagged risk. */
export const RiskSeverity = {
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  CRITICAL: 'critical',
} as const;
export type RiskSeverity = (typeof RiskSeverity)[keyof typeof RiskSeverity];

/** What caused the run (so a host can distinguish an agent's inner loop from a CI gate). */
export const RunTrigger = {
  EDIT: 'edit',
  CI: 'ci',
  MANUAL: 'manual',
  OEM: 'oem',
} as const;
export type RunTrigger = (typeof RunTrigger)[keyof typeof RunTrigger];

/** How a changed file changed (drives the risk tagger). */
export const RunChangeKind = {
  ADDED: 'added',
  MODIFIED: 'modified',
  DELETED: 'deleted',
} as const;
export type RunChangeKind = (typeof RunChangeKind)[keyof typeof RunChangeKind];

/** Who/what drove the run. */
export const RunAgentKind = {
  CODING_AGENT: 'coding-agent',
  OEM_PIPELINE: 'oem-pipeline',
  HUMAN: 'human',
} as const;
export type RunAgentKind = (typeof RunAgentKind)[keyof typeof RunAgentKind];

/** The app framework, when known. */
export const RunFramework = {
  REACT: 'react',
  NEXT: 'next',
  VITE: 'vite',
  OTHER: 'other',
} as const;
export type RunFramework = (typeof RunFramework)[keyof typeof RunFramework];

/** Where the run executed. */
export const RunEnv = {
  PREVIEW: 'preview',
  CI: 'ci',
  LOCAL: 'local',
} as const;
export type RunEnv = (typeof RunEnv)[keyof typeof RunEnv];

/** Verdict confidence. */
export const RunConfidence = {
  HIGH: 'high',
  MEDIUM: 'medium',
  LOW: 'low',
} as const;
export type RunConfidence = (typeof RunConfidence)[keyof typeof RunConfidence];

/**
 * The data profile a run was produced under. DEV exposes dev-only fields (source file:line, raw
 * network bodies, full state dumps); PROD_PREVIEW redacts them. The artifact records which profile
 * produced it so a consumer can never mistake a redacted run for a complete one.
 */
export const RunProfile = {
  DEV: 'dev',
  PROD_PREVIEW: 'prod-preview',
} as const;
export type RunProfile = (typeof RunProfile)[keyof typeof RunProfile];

/** A source coordinate, when source mapping is available (DEV profile only). */
export const SourceLocationSchema = z.object({
  file: z.string(),
  line: z.number().optional(),
  component: z.string().optional(),
});
export type SourceLocation = z.infer<typeof SourceLocationSchema>;

/** A file the change set touched, with the risk surfaces it implicates. */
export const RunChangedFileSchema = z.object({
  path: z.string(),
  changeKind: z.nativeEnum(RunChangeKind),
  risk: z.array(z.nativeEnum(RiskSurface)).default([]),
});
export type RunChangedFile = z.infer<typeof RunChangedFileSchema>;

/** A flow that was replayed as part of the run. */
export const RunFlowResultSchema = z.object({
  name: z.string(),
  status: z.nativeEnum(RunFlowStatus),
  steps: z.number(),
  durationMs: z.number(),
  oracle: z.string().optional(),
  healed: z
    .object({ from: z.string(), to: z.string(), consequenceVerified: z.boolean() })
    .optional(),
  evidenceRef: z.string().optional(),
  failureReason: z.string().optional(),
});
export type RunFlowResult = z.infer<typeof RunFlowResultSchema>;

/** A standalone assertion not tied to a flow. `evidence` is opaque (narrowed per kind by the caller). */
export const RunCheckSchema = z.object({
  kind: z.preprocess(
    (given) => ('string' === typeof given ? (OLD_CHECK_KIND_SPELLING[given] ?? given) : given),
    z.nativeEnum(PredicateKind),
  ),
  predicate: z.string(),
  status: z.preprocess(
    (given) => ('string' === typeof given ? (OLD_CHECK_STATUS_SPELLING[given] ?? given) : given),
    z.nativeEnum(Verified),
  ),
  evidence: z.unknown().optional(),
  /**
   * Was this claim written down BEFORE the action, or after it?
   *
   * The difference between a check and a rationalisation. Afterwards, anything that happened can be
   * described as what you meant; a claim made in advance can only be met or missed.
   *
   * Optional, and absence is not `false`. `false` says the claim came afterwards. Absent says nobody
   * recorded which, and those are different facts about the evidence.
   */
  declaredBeforeActing: z.boolean().optional(),
  /**
   * What kind of evidence bought this answer.
   *
   * A green paid for with "something matching was on screen" is not the same green as one paid for
   * with "the request went out", and a report that flattens them lets the cheap one pass for the
   * dear one. Free-form because the grades belong to whoever produced the verdict.
   */
  grade: z.string().optional(),
  /**
   * What could not be seen while this was being checked.
   *
   * The property with no prior art: every other test report in existence is silent about its own
   * blind spots. An empty list means nothing was hidden; absence means nobody looked.
   */
  couldNotSee: z.array(z.string()).optional(),
});
export type RunCheck = z.infer<typeof RunCheckSchema>;

/** A flagged risk. `gated` = a policy gate tripped on this surface. */
export const RunRiskSchema = z.object({
  surface: z.nativeEnum(RiskSurface),
  severity: z.nativeEnum(RiskSeverity),
  detail: z.string(),
  evidence: z
    .object({
      file: z.string().optional(),
      line: z.number().optional(),
      network: z.string().optional(),
    })
    .optional(),
  gated: z.boolean().default(false),
});
export type RunRisk = z.infer<typeof RunRiskSchema>;

/** The cross-layer evidence behind the verdict. Raw bodies / full state appear only under DEV profile. */
export const VerificationEvidenceSchema = z.object({
  consoleErrors: z
    .array(z.object({ level: z.string(), message: z.string(), at: z.number() }))
    .default([]),
  networkAnomalies: z
    .array(
      z.object({
        method: z.string(),
        url: z.string(),
        status: z.number().optional(),
        issue: z.string(),
      }),
    )
    .default([]),
  stateAssertions: z
    .array(
      z.object({
        store: z.string(),
        path: z.string(),
        expected: z.unknown(),
        actual: z.unknown(),
        ok: z.boolean(),
      }),
    )
    .default([]),
  timeline: z
    .array(z.object({ at: z.number(), kind: z.string(), summary: z.string() }))
    .default([]),
});

/** One paste-ready fix instruction for the host's coding agent. */
export const RepairPacketSchema = z.object({
  flow: z.string().optional(),
  step: z.number().optional(),
  expected: z.string(),
  actual: z.string(),
  sourceLocation: SourceLocationSchema.optional(),
  suggestedPrompt: z.string(),
});
export type RepairPacket = z.infer<typeof RepairPacketSchema>;

/** The verdict block — what a deploy gate reads. */
export const RunVerdictSchema = z.object({
  status: z.nativeEnum(VerdictStatus),
  reasons: z.array(z.string()).default([]),
  confidence: z.nativeEnum(RunConfidence),
  blockingRisks: z.number().default(0),
  /**
   * Which check this verdict is about, so a later one can say it corrects this.
   *
   * Optional because a run's overall verdict is not about one check. A verdict with no check named
   * cannot be cited, and therefore cannot be corrected -- see revision.ts.
   */
  checkId: z.string().optional(),
  /**
   * The verdict this one replaces, written as `<runId>#<checkId>`.
   *
   * Present only on a correction. The verdict it names is NOT edited: it stays exactly as it was
   * given, and this is a second, later answer that cites it. Rewriting the first in place would
   * erase the fact that it was ever given, and "we always knew" is the shape of the problem this
   * whole system exists to prevent.
   */
  supersedes: z.string().optional(),
});
export type RunVerdict = z.infer<typeof RunVerdictSchema>;

/** Optional tamper-evidence signature over the run (for audit; populated later). */
export const RunSignatureSchema = z.object({
  alg: z.string(),
  value: z.string(),
  signedAt: z.number(),
});

/**
 * The top-level verification-run artifact. Stable contract — additive changes only within a
 * RUN_FILE_VERSION; a breaking change bumps it. Arrays default to empty so a minimal run (e.g. a
 * single smoke flow) still validates. Version 1 files are still read; see the note on the constant.
 */
export const ReticleVerificationRunSchema = z.object({
  // All three versions are read; only the current one is written. Each older version differs from
  // its successor in exactly one way -- how a check's kind is spelled, then how its outcome is --
  // and both are translated above, so there is nothing else to migrate.
  schemaVersion: z.union([
    z.literal(RUN_FILE_VERSION),
    z.literal(RUN_FILE_VERSION_BEFORE_UNDETERMINED_CHECKS),
    z.literal(RUN_FILE_VERSION_BEFORE_ONE_VOCABULARY),
  ]),
  runId: RunIdSchema,
  createdAt: z.number(), // epoch ms — INJECTED, never computed in pure logic
  durationMs: z.number(),
  profile: z.nativeEnum(RunProfile),

  project: z.object({
    name: z.string(),
    framework: z.nativeEnum(RunFramework),
    commit: z.string().optional(),
    env: z.nativeEnum(RunEnv).optional(),
    previewUrl: z.string().optional(),
  }),

  agent: z.object({
    id: z.string(),
    kind: z.nativeEnum(RunAgentKind),
    model: z.string().optional(),
  }),

  trigger: z.object({
    kind: z.nativeEnum(RunTrigger),
    diffRef: z.string().optional(),
    note: z.string().optional(),
  }),

  /**
   * Which round of source edits this evidence belongs to.
   *
   * Evidence gathered before the change under test is true about the OLD code. Reporting it as true
   * about the new code is a false pass, and it is the kind nobody notices because everything looks
   * green. Absent when the run had no way to know.
   */
  editEpoch: z.number().optional(),

  changedFiles: z.array(RunChangedFileSchema).default([]),
  flows: z.array(RunFlowResultSchema).default([]),
  checks: z.array(RunCheckSchema).default([]),
  risks: z.array(RunRiskSchema).default([]),
  evidence: VerificationEvidenceSchema,
  repair: z.object({ failurePackets: z.array(RepairPacketSchema).default([]) }).optional(),
  verdict: RunVerdictSchema,
  signature: RunSignatureSchema.optional(),
});
export type ReticleVerificationRun = z.infer<typeof ReticleVerificationRunSchema>;

export type VerificationEvidence = z.infer<typeof VerificationEvidenceSchema>;
export type RunSignature = z.infer<typeof RunSignatureSchema>;
