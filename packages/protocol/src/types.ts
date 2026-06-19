import { z } from 'zod';
import {
  ActionType,
  AnchorKind,
  AnnotationKind,
  type AnnotationErrorCode,
  type AnnotationTarget,
  type DriftReason,
  ElementState,
  FLOW_FILE_VERSION,
  type HealStatus,
  QueryBy,
  type ReplayStatus,
  RunKind,
  RunStatus,
} from './constants.js';

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

/** The app's testable surface — persisted form of the browser Capabilities. */
export const CapabilitiesSchema = z.object({
  testids: z.array(z.string()),
  signals: z.array(z.string()),
  stores: z.array(z.string()),
  flows: z.array(CapabilityFlowSchema),
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
 * A semantic anchor: how a step re-finds its element/event at replay
 * time. Never a volatile eXX ref. testid/role+name bind a DOM element; signal binds an event.
 */
export const FlowAnchorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal(AnchorKind.TESTID), value: z.string().min(1) }),
  z.object({
    kind: z.literal(AnchorKind.ROLE),
    role: z.string().min(1),
    name: z.string().optional(),
  }),
  z.object({ kind: z.literal(AnchorKind.SIGNAL), name: z.string().min(1) }),
]);
export type FlowAnchor = z.infer<typeof FlowAnchorSchema>;

/** A post-condition a step asserts (compiled from a structured annotation; optional). */
export const FlowExpectSchema = z.object({
  signal: z.string().optional(),
  /**
   * Optional payload shape an `assert-signal` annotation requires the signal
   * to match (the predicate DSL's signal.dataMatches). Additive/optional — a flow file with a
   * bare `signal` still parses, and the on-disk version stays FLOW_FILE_VERSION 1.
   */
  signalData: z.record(z.unknown()).optional(),
  net: z
    .object({
      method: z.string().optional(),
      urlContains: z.string().optional(),
      status: z.number().optional(),
    })
    .optional(),
  element: z
    .object({
      testid: z.string().optional(),
      role: z.string().optional(),
      name: z.string().optional(),
    })
    .optional(),
});
export type FlowExpect = z.infer<typeof FlowExpectSchema>;

/** One step of a flow: an anchored action (+ optional expectation). */
export interface FlowStep {
  /** IrisTool.ACT | IrisTool.ACT_SEQUENCE (the server-side tool constant). */
  tool: string;
  anchor: FlowAnchor;
  action?: ActionType;
  args?: Record<string, unknown>;
  expect?: FlowExpect;
  /** true when the anchor is best-effort (no testid was resolvable at record time). NOT dropped. */
  degraded?: boolean;
  /** sub-steps for an act_sequence, each independently anchored. */
  steps?: FlowStep[];
}

const baseFlowStep = z.object({
  tool: z.string(),
  anchor: FlowAnchorSchema,
  action: z.nativeEnum(ActionType).optional(),
  args: z.record(z.unknown()).optional(),
  expect: FlowExpectSchema.optional(),
  degraded: z.boolean().optional(),
});

export const FlowStepSchema: z.ZodType<FlowStep> = baseFlowStep.extend({
  steps: z.lazy(() => z.array(FlowStepSchema).optional()),
}) as z.ZodType<FlowStep>;

/**
 * A legible-drift record returned when an anchor misses at replay.
 * The "whose fault is it" payload: what was expected, why it's gone, and the closest surviving
 * anchor (a concrete fix suggestion). Never a bare "command failed".
 */
export interface Drift {
  /** Named reason kind (testid not found / signal not observed). */
  reasonKind: DriftReason;
  /** Human sentence, e.g. `testid "chat-send" not found`. */
  reason: string;
  /** The missed anchor value (the testid string, or the signal name). */
  anchor: string;
  /** Closest present testid via the live near-miss; null only when the page has no testids (or signal drift). */
  nearest: string | null;
  /**
   * True when two or more present testids tie at the minimum edit distance, so `nearest` is an
   * arbitrary pick. An ambiguous drift is NEVER auto-healed (a wrong rebind ships a bug green) —
   * it is surfaced for a human/agent to choose. Absent ⇒ unambiguous.
   */
  ambiguous?: boolean;
}

/** The per-step result of re-resolving + running one anchored step. */
export interface FlowStepResult {
  /** 0-based index of this step in the flow. */
  step: number;
  /** The server-side tool constant the step runs (IrisTool.ACT | ACT_SEQUENCE). */
  tool: string;
  /** The testid/signal value the step is bound to (the re-resolved anchor). */
  anchor: string;
  /**
   * The route (pathname) the page was on when this step ran — the "which page" of the journey.
   * Additive/optional: present when a route is observable, absent in route-less contexts (e.g. a
   * fake session with no route events). Lets a replay result read as a page-by-page journey.
   */
  page?: string;
  /**
   * A compact summary of the observable CONSEQUENCE in the window right after this step ran — the
   * "what happened" of the journey: a route change, a domain signal (e.g. a modal opening), a
   * network call, or console errors. Additive/optional and intentionally terse (token-cheap). It
   * captures what had landed by the time the action settled, so a very-late async effect may not
   * appear; the asserted consequence (expect/success) is the authoritative pass/fail signal.
   */
  consequence?: string;
  ok: boolean;
  error?: string;
  note?: string;
  /** Present iff this step stopped on an anchor miss. */
  drift?: Drift;
  /**
   * A confidence-scored nearest-match rebind for this drifted step (additive,
   * optional). Set only for a confident testid drift.
   */
  proposal?: HealProposal;
}

/** The iris_flow_replay envelope. */
export interface FlowReplayResult {
  name: string;
  status: ReplayStatus;
  steps: FlowStepResult[];
  /** Set when status === 'error' (load failure or resolved action failure). */
  error?: { code: string; message: string };
  /**
   * The confident rebind proposals aggregated across drifted steps (additive,
   * optional — present only when at least one drifted step has a confident nearest match).
   */
  proposals?: HealProposal[];
}

/**
 * The on-disk flow file: diffable, git-tracked, anchor-resolved.
 * The optional `dynamic` field (both `dynamic` + `success` are optional, so a
 * file with neither still parses — back-compat is locked by a test).
 */
export const FlowFileSchema = z.object({
  version: z.literal(FLOW_FILE_VERSION),
  name: z.string(),
  /**
   * The business goal this flow exists to verify, one line (e.g. "ship a deploy to production").
   * Optional + back-compat (a flow without it still parses). Set via an `intent` annotation. The
   * point of "intent + outcome oracle": a flow that declares an intent should also assert an
   * observable business OUTCOME (a consequence success-state), or it claims to verify a goal it
   * cannot actually check — flow-classify flags that gap.
   */
  intent: z.string().optional(),
  // FUTURE: fixtures/preconditions — schema slot reserved, unpopulated this cut. The recorder
  // never writes it and no fixture runner exists.
  fixture: z.string().optional(),
  /** From the injected clock (ms) — deterministic in tests, byte-stable on disk. */
  createdAt: z.number(),
  steps: z.array(FlowStepSchema),
  success: FlowExpectSchema.optional(),
  /**
   * Anchors whose CONTENT must not be asserted (e.g. LLM output). Replay asserts
   * presence, not words. Compiled from a `mark-dynamic` annotation.
   */
  dynamic: z.array(FlowAnchorSchema).optional(),
});
export type FlowFile = z.infer<typeof FlowFileSchema>;

/**
 * The in-page → wire payload for a finished human recording. The browser
 * compiles captured interactions into a FlowFile-shaped object (resolving semantic anchors at
 * capture time) and emits it as ONE EventType.FLOW_RECORDED event; the server persists it.
 */
export const RecordedFlowSchema = z.object({
  name: z.string(),
  flow: FlowFileSchema,
});
export type RecordedFlow = z.infer<typeof RecordedFlowSchema>;

/** A concrete, confidence-scored rebind proposed for one drifted step. */
export interface HealProposal {
  /** 0-based step index in the flow. */
  step: number;
  /** Old (missing) testid anchor value. */
  from: string;
  /** Proposed nearest present testid. */
  to: string;
  /** Normalized (0,1]; >= HEAL_CONFIDENCE_MIN to be applicable. */
  confidence: number;
}

/** One applied rebind (a HealProposal that was written to disk). */
export interface HealChange {
  step: number;
  from: string;
  to: string;
}

/** The iris_flow_heal envelope. */
export interface FlowHealResult {
  name: string;
  status: HealStatus;
  /** Whether the file was rewritten (true only when status === 'healed'). */
  applied: boolean;
  /** Confident, applicable rebinds. With apply:false these are the dry-run diff. */
  proposals: HealProposal[];
  /** Anchors actually written (empty unless applied). */
  changed: HealChange[];
  /** Human one-liner for the agent (e.g. "nothing to heal", floor explanation). */
  message: string;
  error?: { code: string; message: string };
}

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
    kind: z.literal(AnnotationKind.MARK_DYNAMIC),
    testid: z.string().min(1),
  }),
  z.object({
    kind: z.literal(AnnotationKind.SUCCESS_STATE),
    signal: z.string().min(1).optional(),
    testid: z.string().min(1).optional(),
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
