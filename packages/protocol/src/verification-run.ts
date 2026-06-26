/**
 * The IrisVerificationRun artifact — the stable, versioned contract a host platform (an OEM/design
 * partner) or CI consumes after Iris verifies a generated/edited app. It is assembled from data Iris
 * already produces (flow replay, asserts, evidence timeline, source mapping); this file only defines
 * the WIRE/DISK shape so it can be frozen under semver. Persisted at `.iris/runs/<runId>.json` and
 * returned by the programmatic Replay/Verify API.
 *
 * Conventions match the rest of `@syrin/iris-protocol`: enums are `as const` objects narrowed with
 * `z.nativeEnum`, timestamps are epoch-ms NUMBERS (the clock is injected — never read inside pure
 * logic), no `any` (opaque evidence is `z.unknown()`), and every domain string is a named constant.
 */

import { z } from 'zod';

/** Schema version stamped into every run file so a reader can reject/upgrade old artifacts. */
export const RUN_FILE_VERSION = 1;

/**
 * A run's identity, branded so it can't be confused with another id (e.g. a flow name) that also feeds
 * path helpers. The schema brands on parse; mint a fresh one with asRunId at a trusted/validated point.
 */
export const RunIdSchema = z.string().brand<'RunId'>();
export type RunId = z.infer<typeof RunIdSchema>;
/** Mint a RunId from a raw string — call only at a validated boundary (e.g. behind isValidRunId). */
export const asRunId = (value: string): RunId => value as RunId;

/**
 * Retention bound for .iris/runs/ so disk stays bounded over a long-running pipeline. Pruned
 * oldest-first only once the count exceeds RUN_RETENTION + RUN_RETENTION_SLACK, then back down to
 * RUN_RETENTION — so the O(n) prune is amortized (≈ once per SLACK writes), not paid on every write.
 */
export const RUN_RETENTION = 500;
export const RUN_RETENTION_SLACK = 100;

/** Structured outcome when reading a run file fails (never thrown). Mirrors ProjectReadError. */
export const RunReadError = {
  MISSING: 'run-missing', // no .iris/runs/<id>.json on disk
  MALFORMED: 'run-malformed', // present but not valid JSON / fails schema
} as const;
export type RunReadError = (typeof RunReadError)[keyof typeof RunReadError];

/** The overall verdict on a verification run. PARTIAL = some flows passed, some failed/were gated. */
export const VerdictStatus = {
  PASS: 'pass',
  FAIL: 'fail',
  PARTIAL: 'partial',
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

/** The kind of standalone assertion captured outside a flow (drives `evidence` narrowing downstream). */
export const RunCheckKind = {
  SIGNAL: 'signal',
  NETWORK: 'network',
  ELEMENT: 'element',
  STATE: 'state',
  CONSOLE: 'console',
  LAYOUT: 'layout',
} as const;
export type RunCheckKind = (typeof RunCheckKind)[keyof typeof RunCheckKind];

/** Binary status of a single check. */
export const RunCheckStatus = {
  PASS: 'pass',
  FAIL: 'fail',
} as const;
export type RunCheckStatus = (typeof RunCheckStatus)[keyof typeof RunCheckStatus];

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
  kind: z.nativeEnum(RunCheckKind),
  predicate: z.string(),
  status: z.nativeEnum(RunCheckStatus),
  evidence: z.unknown().optional(),
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
});
export type RunVerdict = z.infer<typeof RunVerdictSchema>;

/** Optional tamper-evidence signature over the run (for audit; populated later). */
export const RunSignatureSchema = z.object({
  alg: z.string(),
  value: z.string(),
  signedAt: z.number(),
});

/**
 * The top-level verification-run artifact. Stable contract — additive changes only within
 * RUN_FILE_VERSION 1; a breaking change bumps the version. Arrays default to empty so a minimal
 * run (e.g. a single smoke flow) still validates.
 */
export const IrisVerificationRunSchema = z.object({
  schemaVersion: z.literal(RUN_FILE_VERSION),
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

  changedFiles: z.array(RunChangedFileSchema).default([]),
  flows: z.array(RunFlowResultSchema).default([]),
  checks: z.array(RunCheckSchema).default([]),
  risks: z.array(RunRiskSchema).default([]),
  evidence: VerificationEvidenceSchema,
  repair: z.object({ failurePackets: z.array(RepairPacketSchema).default([]) }).optional(),
  verdict: RunVerdictSchema,
  signature: RunSignatureSchema.optional(),
});
export type IrisVerificationRun = z.infer<typeof IrisVerificationRunSchema>;
