import { z } from 'zod';
import {
  ActionType,
  AnchorKind,
  type DriftReason,
  FLOW_FILE_VERSION,
  type HealStatus,
  type ReplayStatus,
} from './constants.js';

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
  // Auto-anchor: re-find an element by component identity / source location when it has no testid.
  // component or source carries the durable signal; role/name are disambiguating extras.
  z.object({
    kind: z.literal(AnchorKind.COMPONENT),
    component: z.string().optional(),
    source: z
      .object({ file: z.string(), line: z.number(), column: z.number().optional() })
      .optional(),
    role: z.string().optional(),
    name: z.string().optional(),
  }),
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
      /**
       * Exact number of matching requests since the action — turns presence into a cardinality
       * assertion. Catches the double-submit / useEffect-double-fire / retry-storm regression class:
       * the request fired (presence passes) but fired the WRONG number of times. Omit = presence (≥1).
       */
      count: z.number().int().nonnegative().optional(),
    })
    .optional(),
  /**
   * Console golden end-condition: assert the action logged (or, with absent:true, did NOT log) a
   * console message at `level` (default 'error'). `absent:true` is the common case — "the action
   * completed with a clean console" — catching the regression where an action throws a caught error
   * / logs an uncaught rejection while the UI still renders fine (a presence check passes it).
   */
  console: z
    .object({
      level: z.string().optional(),
      absent: z.boolean().optional(),
    })
    .optional(),
  element: z
    .object({
      testid: z.string().optional(),
      role: z.string().optional(),
      name: z.string().optional(),
    })
    .optional(),
  /**
   * Assert a registered store's value — the source of truth no DOM/network read can reach. Compiles
   * to the predicate engine's `state` predicate. Additive/optional — a flow without it still parses
   * and the on-disk version stays FLOW_FILE_VERSION 1. `equals` accepts a literal, omitted = presence,
   * or a `{ $gte | $contains | $length }` operator pattern.
   */
  state: z
    .object({
      store: z.string().optional(),
      path: z.string(),
      equals: z.unknown().optional(),
      /**
       * Treat this as an INVARIANT that must still hold AFTER the action settles, rather than a
       * condition to wait for. Set it for a blast-radius check ("this unrelated path must NOT have
       * moved") — without it a wait-until-true read passes before an over-reaching side-effect lands.
       */
      hold: z.boolean().optional(),
    })
    .optional(),
});
export type FlowExpect = z.infer<typeof FlowExpectSchema>;

/** One step of a flow: an anchored action (+ optional expectation). */
export interface FlowStep {
  /** ReticleTool.ACT | ReticleTool.ACT_SEQUENCE (the server-side tool constant). */
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
  /** The server-side tool constant the step runs (ReticleTool.ACT | ACT_SEQUENCE). */
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

/**
 * The autonomy decision envelope — the feedback a human used to give, made machine-actionable. From
 * a replay result it states the verdict, what changed, WHERE in the source to look (file:line, from a
 * component anchor), a suggested fix, and the single next action — so a coding agent decides its next
 * move without a human in the loop. Terse by design (token-cheap).
 */
export interface ReplayDecision {
  /** pass = intent held; drift = a locator/anchor missed; fail = an action or the success oracle failed. */
  verdict: 'pass' | 'drift' | 'fail';
  /** One-line human/agent summary of the outcome. */
  summary: string;
  /** What regressed (the drift reason or failure), when not a pass. */
  whatChanged?: string;
  /** Where to look — `file:line` from the failing step's source anchor, or the page route. */
  whereInSource?: string;
  /** A concrete fix hint (e.g. rebind to the nearest surviving anchor). */
  suggestedFix?: string;
  /** The single next action the agent should take. */
  nextAction: string;
}

/**
 * One flow's line in a suite verdict — pass counts as a name; a failure carries the actionable
 * decision fields so the agent can fix it without re-querying.
 */
export interface SuiteFlowResult {
  flow: string;
  verdict: 'pass' | 'drift' | 'fail';
  whatChanged?: string;
  whereInSource?: string;
  nextAction?: string;
}

/**
 * The consolidated verdict of replaying EVERY known flow — the autonomous loop's "did I break
 * anything, and what do I fix" answer in one deterministic call. Passing flows are counted; only
 * failures carry detail (token-cheap). `status` is fail if any flow drifted or errored.
 */
export interface SuiteVerdict {
  status: 'pass' | 'fail';
  total: number;
  passed: number;
  failed: number;
  summary: string;
  /** Only the failing flows, with their decision (verdict, what changed, where, next action). */
  failures: SuiteFlowResult[];
}

/** The reticle_flow_replay envelope. */
export interface FlowReplayResult {
  name: string;
  status: ReplayStatus;
  steps: FlowStepResult[];
  /** The machine-actionable decision derived from this replay (autonomy layer). */
  decision?: ReplayDecision;
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
  /**
   * The project the flow was recorded against (the connecting session's HELLO `projectId`), stamped at
   * save time. Scopes a flow to its app so a shared daemon's HUD lists only the current project's flows
   * instead of every project that ever saved to that daemon. Optional + back-compat: a flow with no
   * projectId is treated as global (visible everywhere), so pre-existing files parse and still show.
   */
  projectId: z.string().optional(),
  /**
   * The route (pathname) the journey started on, captured at record time. Replay navigates here
   * before step 1 so a flow whose first anchor lives on another page doesn't drift on step 1 ("a
   * step no longer matches") just because replay began on the wrong page. Optional + back-compat: a
   * flow without it (or recorded before this shipped) replays from the current page as before, and
   * the on-disk version stays FLOW_FILE_VERSION 1.
   */
  startPath: z.string().optional(),
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

/** The reticle_flow_heal envelope. */
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

export type RecordedFlow = z.infer<typeof RecordedFlowSchema>;
