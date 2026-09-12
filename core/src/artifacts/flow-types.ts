import { z } from 'zod';
import { ActionType } from '../wire/constants/constants.js';
import type { Contradiction } from '../verdict/findings.js';
// Its own directory's constants, which this file had been reaching through `wire/constants/constants.js`
// to get -- the clearest cost of that re-export: artifacts went out to wire to fetch a symbol
// that had been sitting next door the whole time.
import {
  AnchorKind,
  type DriftReason,
  FLOW_FILE_VERSION,
  FlowStatus,
  type HealStatus,
  type ReplayStatus,
} from './flow-constants.js';

/**
 * The MCP tool names that can appear as a recorded flow step's `tool`. These are the ONLY tool names
 * that cross the wire into a persisted flow file — the browser recorder stamps them, the server replays
 * them, and FlowStep types them — so they live in core, the wire contract. The full agent-facing tool
 * surface stays server-side (ReticleTool); ReticleTool references THESE for the flow-persisted three, so
 * there is one source of truth and a rename cannot silently desync the recorder from the replayer (a
 * tool rename once killed four e2e specs — this closes the browser/server half of that drift).
 */
export const FlowStepTool = {
  ACT: 'reticle_act',
  ACT_SEQUENCE: 'reticle_act_sequence',
  ACT_AND_WAIT: 'reticle_act_and_wait',
} as const;
export type FlowStepTool = (typeof FlowStepTool)[keyof typeof FlowStepTool];

/**
 * A semantic anchor: how a step re-finds its element/event at replay
 * time. Never a volatile eXX ref. testid/role+name bind a DOM element; signal binds an event.
 */
export const FlowAnchorSchema = z.discriminatedUnion('kind', [
  // `source` is provenance, not part of how the step re-finds its element — the testid does that.
  // It rides along so a failure can say which file to open; optional, so existing flow files parse
  // unchanged and FLOW_FILE_VERSION does not move.
  z.object({
    kind: z.literal(AnchorKind.TESTID),
    value: z.string().min(1),
    source: z
      .object({ file: z.string(), line: z.number(), column: z.number().optional() })
      .optional(),
  }),
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

/**
 * A post-condition a step asserts (compiled from a structured annotation; optional).
 *
 * Strict, at every nesting level: an unrecognized key (a typo, or a predicate kind this schema
 * doesn't model, e.g. `allOf`, or a typo'd `net`/`console`/`element`/`state` sub-field) must fail
 * to parse instead of being silently dropped. A loose z.object() here would quietly discard the
 * extra key and leave the step with a weaker (or empty) assertion than its author wrote — the
 * flow then replays green against nothing, having proved no real regression.
 */
export const FlowExpectSchema = z
  .object({
    signal: z.string().optional(),
    /**
     * Optional payload shape an `assert-signal` annotation requires the signal
     * to match (the predicate DSL's signal.dataMatches). Additive/optional — a flow file with a
     * bare `signal` still parses, and the on-disk version stays FLOW_FILE_VERSION 1.
     */
    signalData: z.record(z.unknown()).optional(),
    /**
     * Exact number of times the signal must have fired — the signal-side twin of `net.count`, and the
     * only way a saved flow can keep a cardinality the agent actually asserted. Without it a
     * `count: 1` drive would be recorded as bare presence, which is a strictly WEAKER claim than the
     * one made: the replayed flow then goes green on the double-fire it was recorded to catch.
     * Additive/optional — a flow file with a bare `signal` still parses, and FLOW_FILE_VERSION stays 1.
     */
    signalCount: z.number().int().nonnegative().optional(),
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
      .strict()
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
      .strict()
      .optional(),
    element: z
      .object({
        testid: z.string().optional(),
        role: z.string().optional(),
        name: z.string().optional(),
      })
      .strict()
      .optional(),
    /**
     * Rendered text as an end-condition, using the shapes the assert surface already accepts.
     *
     * The gap this closes: an app with no testids, no `reticle.signal`, no registrable store and no
     * network call on the interaction under test -- a discount price computed and rendered, a
     * formatted total, a derived label -- could not produce an asserted flow AT ALL. Everything the
     * vocabulary offered needed a channel that app does not have, so the only honest outcome was
     * `assertion-free`, which is a permanent green (#811).
     *
     * Derived-DOM rendering is a large share of what actually breaks in a UI, and it was the share
     * that could not be pinned.
     *
     * Classified PRESENCE, not consequence, and that is not a technicality: text is read from the
     * DOM, so a locator healed to the wrong element can still satisfy it. It earns `presence-only`,
     * which is a real grade above `assertion-free` and honestly below `signal`/`net`/`state`.
     */
    text: z
      .object({
        contains: z.string().min(1),
        /** Narrow the search to a container, exactly as the `text` predicate's `scope` does. */
        scope: z.string().optional(),
        /** Assert the text is GONE — the regression check for a cleared error or a dismissed toast. */
        absent: z.boolean().optional(),
        /** Require the match to be visible, not merely present in the DOM. */
        visible: z.boolean().optional(),
      })
      .strict()
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
      .strict()
      .optional(),
  })
  .strict();
export type FlowExpect = z.infer<typeof FlowExpectSchema>;

/** One step of a flow: an anchored action (+ optional expectation). */
export interface FlowStep {
  /** FlowStepTool.ACT | FlowStepTool.ACT_SEQUENCE (core, shared with ReticleTool). */
  tool: string;
  anchor: FlowAnchor;
  action?: ActionType;
  args?: Record<string, unknown>;
  expect?: FlowExpect;
  /** true when the anchor is best-effort (no testid was resolvable at record time). NOT dropped. */
  degraded?: boolean;
  /**
   * How long THIS step's `expect` waits for its consequence, in ms. Overrides the flow's
   * `signalTimeoutMs` and the built-in FLOW_SIGNAL_TIMEOUT_MS default.
   *
   * Replay's wait was a fixed 4s with no way to raise it, and that is not a tuning knob — it decides
   * whether an honest flow can ever be green. Two field reports, same shape: a login whose POST takes
   * a measured 5.5s against a remote Postgres, and a CAD import whose LLM-backed perception takes
   * ~22s. Both were verified live with `act_and_wait { timeout_ms }`, both drifted on replay at
   * ~4020ms with `signal_not_observed`, and both were reported to the user as NO LONGER TRUE — a
   * working feature called a regression. The only ways to green them were to weaken or delete the
   * assertion, which the rules correctly forbid, so the flow was honest and permanently red.
   *
   * One agent tried exactly this field and `expect.timeout_ms`, and both were silently dropped.
   * Replay must not be stricter than the tool that recorded the step.
   */
  timeoutMs?: number;
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
  timeoutMs: z.number().int().positive().optional(),
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
/**
 * Counts of what an app did inside one window, and the width of that window.
 *
 * Defined HERE because it is part of the artifact contract, and consumed by the engine that computes
 * it: core is the bottom of the graph and everything depends on it, so one shape lives in one place
 * rather than being declared twice and drifting.
 */
export interface ReactionSummary {
  total: number;
  network: number;
  domAdded: number;
  domRemoved: number;
  domChanged: number;
  routeChanges: number;
  consoleErrors: number;
  animations: number;
  signals: number;
}

/**
 * The digest's counts: `total` always, every other counter only when it is NON-ZERO.
 *
 * This shape is sparse and the full `ReactionSummary` above is not, on purpose. The digest ships on
 * every step of every replay and on every `act_and_wait`; the full report does not. Measured on a
 * real four-step replay, 25 of 36 counters were zero — every step spelling out `"network":0,
 * "domAdded":0,"routeChanges":0,…` whether or not anything moved.
 *
 * Omitting a zero is a ROUTE cut and never an evidence cut: an absent counter IS zero, so the reader
 * answers the same question from the same facts. Read one as `summary.network ?? 0`.
 *
 * `total` is unconditional because "the window was empty" is itself evidence, and a summary with no
 * keys could not be told apart from one that was never computed.
 */
export type ReactionSummaryDigest = { total: number } & Partial<Omit<ReactionSummary, 'total'>>;

/** The lean reaction report: the window and the counts, without the per-event timeline. */
export interface ReactionDigest {
  window_ms: number;
  summary: ReactionSummaryDigest;
}

export interface FlowStepResult {
  /** 0-based index of this step in the flow. */
  step: number;
  /**
   * The tool the step runs — FlowStepTool.ACT | ACT_SEQUENCE | the synthetic success oracle.
   *
   * OMITTED when it is `ACT`, which 137/137 steps in this repo's corpus are. Read it as
   * `tool ?? FlowStepTool.ACT`. Every reader only ever asks "is this the success oracle?", and a
   * missing field is correctly falsy against that — so the coercion fails in the safe direction.
   */
  tool?: string;
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
  /**
   * Wall-clock ms this step took (dispatch → post-settle), from the session's injected elapsed clock.
   * Additive/optional: absent in contexts with no advancing clock. Feeds per-step run-to-run perf diffs.
   */
  durationMs?: number;
  /**
   * The event-stream span this step's evidence lives in — its drill address.
   *
   * `reticle_observe` already accepts `{ since, until }` and returns "the span between action A and
   * B", so a step that carries its own window is a step somebody can ask about afterwards without
   * re-driving anything. Without it the evidence is captured and has no address, which is why a
   * deterministic run could say a step passed and nothing more.
   *
   * Bounded on BOTH ends deliberately. A `since` alone returns everything from that point to now, so
   * on a long flow step two's window would include steps three through twenty-five — and an agent
   * reading it would attribute the whole tail to one click.
   *
   * Additive/optional, and omitted rather than zero-width where no clock advanced: a `{since: 0,
   * until: 0}` would read as "this step caused nothing" instead of "nothing here measures time".
   */
  window?: { since: number; until: number };
  /**
   * What the app DID in that window, as counts.
   *
   * `consequence` beside it is a sentence — readable, and not scannable. Twenty-five sentences is
   * prose somebody has to read; twenty-five of these is a surface they can skim for the one row that
   * is unlike the others, which is the whole difference between a step ledger and a wall of text.
   *
   * The counts, not the events. The per-event timeline is the expensive half and it is one
   * `reticle_observe { since, until }` away using this step's own `window`, so the cheap form is
   * what travels and the full form is addressable rather than sent.
   */
  digest?: ReactionDigest;
  /**
   * Channels that DISAGREE about what this step did — reported even when the step passed.
   *
   * That is the entire point. A step whose anchor resolved, whose action fired and whose declared
   * consequence held, while a request in the same window failed, is the false green this product
   * exists to catch. The detectors run independently of the assertion, so a green step with an entry
   * here is a finding, not a contradiction in terms.
   *
   * Omitted when the channels agree, never an empty array: a field that is always present teaches a
   * reader to skim past it, and the whole value here is that its presence is the signal.
   */
  contradictions?: Contradiction[];
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
  /**
   * The flow never ran: its file failed to load, or its leased context never came up. Nothing was
   * learned about the app, so this row is not a regression — it is Reticle reporting its own failure
   * in the same array as the app's. Measured: one sweep emitted 8 `flow-regression` bug_found events
   * off rows like these, from a suite where no flow ever executed.
   */
  couldNotRun?: boolean;
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
  /**
   * `unverifiable` means the suite contained flows that CANNOT FAIL, so "pass" would be a lie.
   *
   * A recorded flow with no steps, or one that asserts no observable consequence, replays green no
   * matter what the app does. Reporting `pass` for it is a false green in the exact feature sold as
   * the regression suite — measured: a flow saved as `{steps: [], intent: "..."}`, which `flow_save`
   * had ALREADY graded assertion-free with a warning, came back "all 1 flow pass".
   */
  status: 'pass' | 'fail' | 'unverifiable';
  total: number;
  passed: number;
  failed: number;
  summary: string;
  /** Only the failing flows, with their decision (verdict, what changed, where, next action). */
  failures: SuiteFlowResult[];
  /**
   * Flows that replayed without error but assert nothing, so their green means nothing. Counted
   * apart from `passed` — a number that includes them is not a count of anything verified.
   */
  unverifiable?: { flow: string; reason: string }[];
  /**
   * Flows that have both passed AND failed on UNCHANGED code — intermittent, not regressions.
   *
   * A flake and a regression demand opposite responses: one is chased, the other is quarantined. The
   * ledger that answers this already existed and was written only by the CLI, so an agent replaying a
   * suite a hundred times could never learn which of its failures were noise. Omitted entirely when
   * the ledger has not seen enough runs to say.
   */
  flaky?: string[];
  /**
   * How much of what the suite DROVE it actually proved.
   *
   * `unverifiable` above catches a flow that asserts nothing at all. It cannot catch the commoner
   * shape: a flow of twelve steps where three declare a consequence and nine do not. That flow
   * passes, counts in `passed`, and nine of its steps would have replayed green whether or not the
   * feature worked.
   *
   * So the count travels. Sixty-three steps driven and forty-seven declared is not "75% verified" —
   * it is verified for forty-seven and silent about sixteen, and only a number carrying both lets a
   * reader tell those apart. Omitted when no flow file was available to count, because an invented
   * zero would read as "nothing was declared" rather than "nothing was counted".
   */
  coverage?: { steps: number; declared: number };
  /**
   * Known routes this run never opened.
   *
   * `coverage` above counts what the suite DROVE. Neither it nor anything else here notices a route
   * no flow goes near — so a selection replaying two of eleven flows reports "all 2 flows pass",
   * which is true and says nothing about the nine routes that were not looked at.
   *
   * Known means seen before, not enumerated from the app: every flow the project holds contributes
   * the route it starts on. Omitted when the caller knows of no routes, because "0 unreached" from
   * an empty ledger reads as a clean sweep rather than as an unanswered question.
   */
  unreached?: string[];
  /**
   * Every channel disagreement the suite saw, including on flows that PASSED.
   *
   * The step-level rule already says a contradiction is reported regardless of `ok`, for the reason
   * that a step whose action fired and whose consequence held, while a request in the same window
   * failed, is the false green this product exists to catch. The suite verdict returned only its
   * failures, so on a green run every one of those was computed, attached to a step, and discarded
   * at exactly the moment somebody would have read it — a nightly run of a hundred steps reporting
   * "all 12 flows pass".
   *
   * Carrying them also means a green suite is not reported as `pass`: see `status`.
   */
  contradictions?: SuiteContradiction[];
}

/** A step-level contradiction, addressed back to the flow and step that produced it. */
export interface SuiteContradiction extends Contradiction {
  flow: string;
  /** Index within the flow, so the reader can drill straight to the step's own window. */
  step: number;
}

/** The reticle_flow_replay envelope. */
export interface FlowReplayResult {
  name: string;
  status: ReplayStatus;

  /**
   * Contradictions that span steps — found by re-running the detectors over the WHOLE replay, minus
   * everything a step already reported.
   *
   * A step's window closes when the step ends, so a request fired at step 2 and still unanswered at
   * step 5 sits outside every per-step window. It is exactly the shape a long journey produces and
   * exactly the shape a per-step view cannot see.
   *
   * Omitted when the whole-span pass adds nothing over the steps.
   */
  crossStep?: Contradiction[];

  steps: FlowStepResult[];
  /** The machine-actionable decision derived from this replay (autonomy layer). */
  decision?: ReplayDecision;
  /** Set when status === 'error' (load failure or resolved action failure). */
  error?: { code: string; message: string };
  /**
   * Set when the replay STOPPED before the end of the flow.
   *
   * Replay breaks on the first failing step, so a flow that halted returns fewer step results than
   * it has steps — and nothing said so. A caller reading a two-step flow's one result saw a step
   * that was simply absent, which was reported as replay "silently skipping" an action. It does not
   * skip; it stops, and now it says where and how much it never reached. Omitted entirely when every
   * step ran, so a clean pass carries no extra bytes.
   */
  halted?: { atStep: number; notAttempted: number };
  /**
   * Set on an `ok` replay whose flow cannot fail: it asserts no observable consequence, or has no
   * steps at all. The replay genuinely completed, so the status stays `ok` — but a bare `ok` read
   * as proof the feature works is exactly the false confidence `flow-risk.ts` argues against, and
   * `reticle_flow_verify` already refuses to count these as passes. This carries the same reason,
   * from the same function, to the single-flow caller who would otherwise never see it.
   */
  unverifiable?: { reason: string };
  /**
   * The confident rebind proposals aggregated across drifted steps (additive,
   * optional — present only when at least one drifted step has a confident nearest match).
   */
  proposals?: HealProposal[];
  /**
   * The push-default deviation report over this replay's route segments (ranked deviations vs the learned
   * envelope, or a fall-back note below N=3 runs). Additive; present when segments were observed.
   */
  deviation?: unknown;
  /**
   * What the project already knows about this flow, fetched from shared memory on the agent's
   * behalf.
   *
   * Present only when the project is linked, memory sync is on, and the team has actually captured
   * something about this flow. Consulting shared memory used to be a separate act an agent had to
   * remember to perform — measured across a real corpus, every subject showed zero reads, not
   * because the knowledge was useless but because nothing ever asked for it. A verification that
   * asks on the agent's behalf is the difference between memory the platform stores and memory the
   * platform uses.
   *
   * Deliberately additive and deliberately small: a verdict whose own result has been pushed below
   * a wall of statements is a worse verdict.
   */
  knows?: { statement: string; status: string }[];
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
   * The intent-ledger row this flow discharges — the id in `.reticle/intent.json`.
   *
   * `intent` above is the prose a recorder captured; this is the LINK to the ledger that already
   * models declared → bound → proved and records which verdict discharged what. Without it there
   * would be two ways to say what a change is for, which is the defect this codebase keeps paying
   * for: a flow's goal and an intent's statement would drift apart with nothing to reconcile them.
   *
   * Set at save time from the flow's own prose, or written by hand to point a flow at an intent
   * declared earlier via `reticle_intent` — a flow can prove something somebody else declared.
   * Optional + back-compat: a flow without it replays exactly as before, and the on-disk version
   * stays FLOW_FILE_VERSION 1.
   */
  intentId: z.string().optional(),
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
  /**
   * How long every step of this flow waits for its declared consequence, in ms. A step's own
   * `timeoutMs` wins over it; absent both, FLOW_SIGNAL_TIMEOUT_MS applies.
   *
   * Flow-level because slowness is usually a property of the APP, not of one control — a remote
   * database, a model-backed endpoint, a cold container. Optional + back-compat: a flow without it
   * replays exactly as before and the on-disk version stays FLOW_FILE_VERSION 1.
   */
  signalTimeoutMs: z.number().int().positive().optional(),
  success: FlowExpectSchema.optional(),
  /**
   * Anchors whose CONTENT must not be asserted (e.g. LLM output). Replay asserts
   * presence, not words. Compiled from a `mark-dynamic` annotation.
   */
  dynamic: z.array(FlowAnchorSchema).optional(),
  /**
   * Free-form labels a suite selects on — `smoke`, `checkout`, `slow`.
   *
   * Not an enum: the useful sets are the ones a team invents for its own product, and a closed list
   * would mean shipping somebody's release process in the contract. Optional and back-compat, so
   * every flow already on disk keeps loading.
   */
  labels: z.array(z.string().min(1)).optional(),
  /**
   * Flows that must run, and pass, before this one.
   *
   * By name, because a name is what every other caller addresses a flow by. A prerequisite that is
   * not in the run is reported rather than assumed satisfied: a checkout flow whose login was
   * filtered out by a label would otherwise fail for a reason that has nothing to do with checkout.
   */
  needs: z.array(z.string().min(1)).optional(),
  /** Whether a suite runs this flow. Absent means active — see FlowStatus. */
  status: z.enum([FlowStatus.ACTIVE, FlowStatus.QUARANTINED, FlowStatus.DRAFT]).optional(),
  /**
   * Why this flow is out of the suite, who owns getting it back, and since when.
   *
   * Required in full when quarantined, because a quarantine without a reason and an owner is a
   * silent skip wearing a label: it removes the failure from the verdict AND the reason to ever fix
   * it. `until` is the optional half — a date somebody has to look at it again.
   */
  quarantine: z
    .object({
      reason: z.string().min(1),
      since: z.string().min(1),
      owner: z.string().min(1),
      until: z.string().optional(),
    })
    .optional(),
});
export type FlowFile = z.infer<typeof FlowFileSchema>;

/**
 * Is this flow excluded from the suite's verdict?
 *
 * Quarantine takes a flow out of the verdict, which is a real power, and the failure mode is not a
 * malformed file — it is a flow quietly leaving the suite and nobody noticing it went. So this fails
 * TOWARD running it: an incomplete quarantine is treated as no quarantine at all. Whoever wants a
 * flow out has to say why, who owns getting it back, and since when.
 *
 * A function rather than a schema rule, deliberately. The conditional form would be a zod
 * `.refine()` — this package has none, and a refinement does not survive into the generated JSON
 * Schema, so an implementation reading the contract from `schema/` would never see it. "Does this
 * file parse" and "is this flow actually excluded" are two different questions; this is the second.
 *
 * The status is the decision and the block is the paperwork: a leftover note without the status
 * excludes nothing, so tidying a flow back into the suite is one field.
 */
export function isQuarantined(flow: Pick<FlowFile, 'status' | 'quarantine'>): boolean {
  if (flow.status !== FlowStatus.QUARANTINED) return false;
  const q = flow.quarantine;
  return (
    q !== undefined &&
    'string' === typeof q.reason &&
    q.reason.length > 0 &&
    'string' === typeof q.owner &&
    q.owner.length > 0 &&
    'string' === typeof q.since &&
    q.since.length > 0
  );
}

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

/**
 * One replayable-flow chip on the in-page HUD.
 *
 * Crosses the bridge: the daemon builds these from the flows on disk and pushes them with
 * `ReticleCommand.FLOWS`; the presenter panel renders one ▶ button per chip. It lived as two
 * identical `interface FlowChip` declarations — one in the server, one in the browser — which is the
 * shape that drifts silently, because nothing links the two and no test crosses the boundary.
 *
 * A TYPE and not a zod schema on purpose: the browser SDK ships into the user's app and carries no
 * zod, so the receiving side narrows the raw wire value by hand. The type is what both ends agree on.
 */
export interface FlowChip {
  name: string;
  /** The testid the flow's first step anchors to, when it has one — the panel hides chips that cannot start on the current page. */
  start?: string;
}
