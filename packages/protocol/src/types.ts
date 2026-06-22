import { z } from 'zod';
import {
  AnnotationKind,
  type AnnotationErrorCode,
  type AnnotationTarget,
  ElementState,
  QueryBy,
  RunKind,
  RunStatus,
} from './constants.js';
import { RiskSurface } from './verification-run.js';
import type { FlowExpect } from './flow-types.js';

/** A query describing which element(s) to find, Testing-Library style. */
export const ElementQuerySchema = z.object({
  by: z.nativeEnum(QueryBy).optional(),
  value: z.string().optional(),
  role: z.string().optional(),
  name: z.string().optional(),
  text: z.string().optional(),
  label: z.string().optional(),
  placeholder: z.string().optional(),
  testid: z.string().optional(),
  alt: z.string().optional(),
  /** Component display name (auto-anchor resolution). The nearest enclosing component of the target. */
  component: z.string().optional(),
  /** Source location of the target element (auto-anchor resolution) — the precise, granular match. */
  source: z
    .object({ file: z.string(), line: z.number(), column: z.number().optional() })
    .optional(),
  /** CSS selector or ref to scope the search. */
  scope: z.string().optional(),
});
export type ElementQuery = z.infer<typeof ElementQuerySchema>;

/** Compact semantic descriptor of one element surfaced to the agent. */
export interface ElementDescriptor {
  ref: string;
  role: string;
  name: string;
  value?: string;
  states: ElementState[];
  visible: boolean;
  text?: string;
}

export interface MatchResult {
  matched: boolean;
  count: number;
  elements: ElementDescriptor[];
}

/**
 * A semantic cluster of interactive elements in the DOM — the replacement for the raw testid list
 * in zero-match hints. Tells the agent "there is a list with 847 rows" rather than 12 opaque IDs.
 */
export interface PresentRegion {
  /** ARIA role of the container element. */
  role: string;
  /** Accessible name of the container, if present. */
  name?: string;
  /** Number of direct role-bearing children in the container. */
  childCount: number;
  /** Up to 3 `role[name]` strings sampled from the first children (for orientation). */
  sample: string[];
}

/** Diagnostic hint attached to a zero-match iris_query result. */
export interface QueryEmptyHint {
  /** location.pathname + location.search at query time. */
  route: string;
  /** Semantic clusters of the page's interactive regions — the successor to presentTestids. */
  presentRegions: PresentRegion[];
  /** @deprecated Use presentRegions. Kept for one major cycle; removed next major. */
  presentTestids: string[];
  /** True if a capability-registered testid is present in the scope. */
  knownEmptyState: boolean;
}

/** Result of the QUERY command / iris_query tool. `hint` present ONLY on zero matches. */
export interface QueryResult {
  elements: ElementDescriptor[];
  hint?: QueryEmptyHint;
}

/** One named flow advertised by the app (mirrors the browser CapabilityFlow). */
export const CapabilityFlowSchema = z.object({
  name: z.string(),
  steps: z.array(z.string()),
});

/**
 * A declared risk zone — the app naming a surface (auth/payment/db/…) and the paths it covers, so a
 * host can gate on it. Shares RiskSurface with the verification-run verdict so a declaration and a
 * detection speak the same vocabulary. ENFORCED LATER — parsed + surfaced now.
 */
export const RiskZoneSchema = z.object({
  surface: z.nativeEnum(RiskSurface),
  paths: z.array(z.string()).optional(),
  note: z.string().optional(),
});
export type RiskZone = z.infer<typeof RiskZoneSchema>;

/**
 * Optional governance metadata an app may declare about its testable surface: who owns it, safety
 * invariants, allowed scopes, store paths/selectors to redact, and declared risk zones. All optional
 * and additive — a manifest without any of it stays valid (back-compat). Parsed + surfaced now;
 * enforcement (policy gates, redaction-by-declaration) comes later.
 */
export const ManifestGovernanceSchema = z.object({
  owner: z.string().optional(),
  safety: z.array(z.string()).optional(),
  scope: z.array(z.string()).optional(),
  redact: z.array(z.string()).optional(),
  risk: z.array(RiskZoneSchema).optional(),
});
export type ManifestGovernance = z.infer<typeof ManifestGovernanceSchema>;

/** The app's testable surface — persisted form of the browser Capabilities. */
export const CapabilitiesSchema = z.object({
  testids: z.array(z.string()),
  signals: z.array(z.string()),
  stores: z.array(z.string()),
  flows: z.array(CapabilityFlowSchema),
  /** Optional declared governance (owner/safety/scope/redact/risk). Additive — back-compat safe. */
  governance: ManifestGovernanceSchema.optional(),
});
export type CapabilitiesContract = z.infer<typeof CapabilitiesSchema>;

/** The on-disk contract.json envelope: versioned + timestamped capabilities. */
export const ContractFileSchema = z.object({
  version: z.number(),
  generatedAt: z.number(),
  capabilities: CapabilitiesSchema,
});
export type ContractFile = z.infer<typeof ContractFileSchema>;

/**
 * Evidence counts captured with a run so the agent can compare runs over time
 * ("console errors went 0→3 since last run"). All optional: a run records only what it observed.
 */
export const RunEvidenceSchema = z.object({
  consoleErrors: z.number().optional(),
  networkErrors: z.number().optional(),
  driftSteps: z.number().optional(),
});
export type RunEvidence = z.infer<typeof RunEvidenceSchema>;

/** One persisted run outcome in .iris/project.json. */
export const RunRecordSchema = z.object({
  kind: z.nativeEnum(RunKind),
  name: z.string(),
  status: z.nativeEnum(RunStatus),
  at: z.number(),
  summary: z.string().optional(),
  evidence: RunEvidenceSchema.optional(),
  durationMs: z.number().optional(),
});
export type RunRecord = z.infer<typeof RunRecordSchema>;

/** The optional learned map of the app (known flow/route names). */
export const ProjectLearnedSchema = z.object({
  flows: z.array(z.string()).optional(),
  routes: z.array(z.string()).optional(),
});
export type ProjectLearned = z.infer<typeof ProjectLearnedSchema>;

/** The on-disk project.json envelope: versioned learned-map + chronological runs. */
export const ProjectFileSchema = z.object({
  version: z.number(),
  learned: ProjectLearnedSchema.optional(),
  runs: z.array(RunRecordSchema),
});
export type ProjectFile = z.infer<typeof ProjectFileSchema>;

/**
 * The structured annotation REQUEST a human/agent attaches to the live
 * recording (the server-side `iris_annotate` tool). A discriminated union over the four shipped
 * AnnotationKind values. Each variant carries exactly the fields its compilation needs.
 *
 * FIRST CUT boundary (do NOT remove): only this structured union is accepted. A free
 * NATURAL-LANGUAGE annotation (e.g. the string "the diff should appear") is REJECTED by this
 * schema — never guessed/compiled into a predicate. Free NL → predicate compilation is explicitly
 * FUTURE; a `safeParse` of a bare string returns success:false, which the tool maps
 * to AnnotationErrorCode.UNKNOWN_KIND. No NL parser exists or is faked here.
 */
export const AnnotationSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal(AnnotationKind.ASSERT_SIGNAL),
    name: z.string().min(1),
    dataMatches: z.record(z.unknown()).optional(),
  }),
  z.object({
    kind: z.literal(AnnotationKind.ASSERT_VISIBLE),
    testid: z.string().min(1),
  }),
  z.object({
    kind: z.literal(AnnotationKind.ASSERT_STATE),
    statePath: z.string().min(1),
    store: z.string().min(1).optional(),
    equals: z.unknown().optional(),
  }),
  z.object({
    kind: z.literal(AnnotationKind.MARK_DYNAMIC),
    testid: z.string().min(1),
  }),
  z.object({
    kind: z.literal(AnnotationKind.SUCCESS_STATE),
    signal: z.string().min(1).optional(),
    testid: z.string().min(1).optional(),
    // A store-truth golden end-condition: the flow succeeds when this store path holds (e.g. the
    // created deployment actually reached status 'live' in the store, not just on screen).
    statePath: z.string().min(1).optional(),
    store: z.string().min(1).optional(),
    equals: z.unknown().optional(),
    // Treat the statePath as an INVARIANT that must hold AFTER settle (a blast-radius "this unrelated
    // path must not have moved" check), not a condition to wait for.
    hold: z.boolean().optional(),
    // A network-cardinality golden end-condition: the flow succeeds only when EXACTLY `count` matching
    // requests fired (omit count = presence). Catches the double-submit / retry-storm regression class.
    net: z
      .object({
        method: z.string().min(1).optional(),
        urlContains: z.string().min(1).optional(),
        status: z.number().optional(),
        count: z.number().int().nonnegative().optional(),
      })
      .optional(),
    // A console golden end-condition: with absent:true, "the action completed with a clean console"
    // (no message at `level`, default 'error') — catches an action that logs a caught error / rejection
    // while the UI still renders fine.
    console: z
      .object({
        level: z.string().min(1).optional(),
        absent: z.boolean().optional(),
      })
      .optional(),
  }),
  z.object({
    kind: z.literal(AnnotationKind.INTENT),
    text: z.string().min(1),
  }),
]);
export type Annotation = z.infer<typeof AnnotationSchema>;

/**
 * The iris_annotate result envelope (discriminated on `ok`, never a free
 * string). On success it names the target (step|flow) + the human compiled-predicate text the
 * recorder confirmation strip shows ("will assert signal diff:shown").
 */
export type AnnotateResult =
  | { ok: true; target: AnnotationTarget; compiled: string }
  | { ok: false; code: AnnotationErrorCode };

/**
 * The patch a compiled annotation produces. The caller applies it to the
 * AnnotationStore: a step.expect (assert-*), a flow.dynamic[] entry (mark-dynamic), or flow.success
 * (success-state). All optional; exactly the fields the compiled kind needs are set.
 */
export interface AnnotatePatch {
  /** index of the step whose .expect is set (assert-signal / assert-visible). */
  stepIndex?: number;
  stepExpect?: FlowExpect;
  /** the testid pushed into flow.dynamic[] (mark-dynamic). */
  dynamicAdd?: string;
  /** flow.success (success-state). */
  success?: FlowExpect;
  /** flow.intent (intent) — the business goal this flow exists to verify. */
  intent?: string;
}

/** Pure compiler output: the result envelope + (on ok) the patch to apply. */
export interface AnnotateOutcome {
  result: AnnotateResult;
  patch?: AnnotatePatch;
}
