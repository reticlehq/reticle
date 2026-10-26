/**
 * What replaying, verifying and healing a flow REPORT — the result envelopes, as opposed to the flow
 * file they run.
 *
 * Split from `flow-types.ts`, which keeps the on-disk shape and its zod schemas. Everything here is a
 * plain type with no runtime value, and `flow-types.ts` re-exports it, so the one public name for "a
 * flow's types" still answers for both halves.
 */
import type { Contradiction } from '@/verdict/findings.js';
import type { DriftReason, HealStatus, ReplayStatus, SuiteIsolation } from './flow-constants.js';

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
 * every step of every replay and on every `act_and_wait`; the full report does not. Across a
 * four-step replay 25 of 36 counters are typically zero — every step spelling out `"network":0,
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
   * Where the screenshot of the page at this step's outcome is, and how it was taken — or why
   * there is none. A path to open when the look of the page matters; never the image itself.
   */
  screenshot?: { path: string; source: string } | { error: string };
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
   * Where this step lives, rendered, when the flow is a COMPOSITE — `signin#0 (invoked from full#1)`.
   *
   * Absent for a flat flow, where `step` is already the whole answer and an address on every row
   * would be noise on every replay of every flow.
   */
  at?: string;
  /**
   * The route (pathname) the page was on when this step ran — the "which page" of the journey.
   * Additive/optional: present when a route is observable, absent in route-less contexts (e.g. a
   * fake session with no route events). Lets a replay result read as a page-by-page journey.
   */
  page?: string;
  /** The route the page was on once this step settled — where it led. Absent when unobservable. */
  endPage?: string;
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
  /**
   * The console errors and uncaught exceptions this step's window saw, the first few only; `digest`
   * still counts every one. A run artifact's `evidence.consoleErrors` is built from these, so it
   * reports what replay observed instead of claiming a clean console. Omitted when there were none.
   */
  consoleErrors?: { level: string; message: string; at: number }[];
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
  /** The ready-to-paste "Reticle result" block the agent ends with; built by the server. */
  reticleResult?: string;
  /** Only the failing flows, with their decision (verdict, what changed, where, next action). */
  failures: SuiteFlowResult[];
  /**
   * How the flows were kept apart — see `SuiteIsolation`.
   *
   * Absent when the caller did not say. Present, it is the difference between two counts that can
   * be compared and two that cannot: a shared-session pass may be inherited from an earlier flow.
   */
  isolation?: SuiteIsolation;
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
  /**
   * Each flow that cannot replay as it was saved: no starting page, an anchor a replay cannot find
   * or that several elements share, live data in an expect, or a step that writes real data. A
   * drift on such a flow is the flow, not the app. Omitted when every flow replays as saved.
   */
  replayability?: { flow: string; status: string; why?: string[]; writes?: true }[];
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
   * The verification run this replay was written down as, so whoever started it (the platform's
   * Re-verify) can tie its check to the run and a passing replay resolves the issue it was for.
   */
  runId?: string;

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
  /**
   * What this flow knows after this run — every defect it has seen, and whether it is still open.
   *
   * Written back to the flow file so the next replay starts from it. This is how a flow gets
   * stricter without anybody writing a new assertion: a defect observed, then observed GONE, becomes
   * something the app can never quietly reacquire.
   */
  learned?: {
    kind: string;
    step: number;
    state: 'open' | 'guarded';
    cleanRuns?: number | undefined;
  }[];
  /** Defects this run saw disappear. The app got better here. */
  promoted?: string[];
  /** Guarded defects that came back. The app got worse here, and only this flow would have known. */
  regressed?: string[];

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
   * Set when replay waited for the start page longer than the step budget, because the leased tab
   * said the page was still loading (a cold dev server compiling the route). Absent means the wait
   * stayed inside the budget.
   */
  startPageWait?: StartPageWait;
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
   * something about this flow. Shared memory an agent has to remember to consult is never consulted,
   * so the verification asks on the agent's behalf — the difference between memory the platform
   * stores and memory the platform uses.
   *
   * Deliberately additive and deliberately small: a verdict whose own result has been pushed below
   * a wall of statements is a worse verdict.
   */
  knows?: { statement: string; status: string }[];
}

/** How long replay waited for a start page that was still loading. */
export interface StartPageWait {
  /** From the navigation to the page connecting, or to replay giving up. */
  waitedMs: number;
  /** The step budget the wait went past. */
  budgetMs: number;
  /** What the tab said the last time replay asked. True when replay gave up means it gave up at the cap. */
  stillLoading: boolean;
}

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
