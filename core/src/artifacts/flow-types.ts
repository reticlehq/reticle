import * as z from 'zod';
import { CROSS_STEP_ADDRESS } from './flow-step-tool.js';
import { READABLE_FLOW_VERSIONS } from './flow-constants.js';
import { StepEffect } from './step-effect.js';
import { ActionType } from '@/wire/constants/constants.js';
import { CONSEQUENCE_KINDS, PRESENCE_GRADED } from '@/verdict/consequence.js';
import { PredicateKind } from '@/verdict/consequence.js';
import { PredicateSchema, type Predicate } from '@/verdict/predicate.js';
import { sessionBoundField, sessionRefRefusal } from '@/verdict/predicate-tree.js';
import { isConsequenceSource } from '@/verdict/compare-source.js';
import { FlowExpectSchema, flowExpectToPredicate } from './flow-expect-flat.js';

// The older flat shape and its reader live together; both are re-exported so the one public name
// for "a flow's types" still answers for them.
export { FlowExpectSchema, type FlowExpect } from './flow-expect-flat.js';
// Its own directory's constants, which this file had been reaching through `wire/constants/constants.js`
// to get -- the clearest cost of that re-export: artifacts went out to wire to fetch a symbol
// that had been sitting next door the whole time.
import { AnchorKind, FlowStatus } from './flow-constants.js';

// The replay, suite and heal result envelopes live in their own module, re-exported for the same
// reason as the flat expect above.
export * from './flow-results.js';

/**
 * The MCP tool names that can appear as a recorded flow step's `tool`. These are the ONLY tool names
 * that cross the wire into a persisted flow file — the browser recorder stamps them, the server replays
 * them, and FlowStep types them — so they live in core, the wire contract. The full agent-facing tool
 * surface stays server-side (ReticleTool); ReticleTool references THESE for the flow-persisted three, so
 * there is one source of truth and a rename cannot silently desync the recorder from the replayer (a
 * tool rename once killed four e2e specs — this closes the browser/server half of that drift).
 */

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
    // How many elements carried this test id when the step was recorded, when more than one did.
    // A replay takes the first, so a shared test id is named at save instead of found as a drift.
    of: z.number().int().min(2).optional(),
    source: z
      .object({ file: z.string(), line: z.number(), column: z.number().optional() })
      .optional(),
  }),
  z.object({
    kind: z.literal(AnchorKind.ROLE),
    role: z.string().min(1),
    name: z.string().optional(),
    // Which of several same-named controls was recorded, in page order, and how many there were.
    // Honoured only while the page still has exactly `of` of them; otherwise the step is ambiguous.
    nth: z.number().int().min(0).optional(),
    of: z.number().int().min(2).optional(),
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

// A ref is one session's address. Kept, it resolves to nothing on replay — and a scope that
// resolves to nothing SATISFIES an absence check — so the step could never go red. Refused here,
// on the one schema both the save path and the load path go through.
export const FlowPredicateSchema = PredicateSchema.superRefine((predicate, ctx) => {
  const field = sessionBoundField(predicate);
  if (field === undefined) return;
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    message: sessionRefRefusal(field),
  });
});

/**
 * Accept either shape and always yield a PREDICATE.
 *
 * A v2 file stores the predicate directly; a v1 file stores the flat struct, and is lifted on read
 * by `flowExpectToPredicate`. The discriminator is `kind`, which every predicate has and no flat
 * expect ever did, so the two can never be confused for one another.
 *
 * Nothing is written back. A v1 file read this way stays a v1 file on disk, which is what makes the
 * migration safe for flows that are committed to a shared repository.
 */
/*
 * A union rather than a preprocess, and the difference is STRICTNESS.
 *
 * A preprocess lifts the raw object before anything validates it, so a v1 expect carrying a
 * misspelled key would have had that key quietly ignored by the lift and the rest accepted — a
 * stripped field and a green, which is the precise shape this schema was made strict to prevent.
 *
 * Running `FlowExpectSchema` as a branch keeps it: a v2 predicate matches the first branch on its
 * `kind`, a well-formed v1 expect matches the second and is lifted by the transform, and an expect
 * that is neither is refused by both. Strictness at every level of the v1 shape survives unchanged.
 */
const ExpectSchema = z.union([
  FlowPredicateSchema,
  FlowExpectSchema.transform((expect) => flowExpectToPredicate(expect)),
]);

/**
 * The same lift over a LIST, dropping the entries that assert nothing.
 *
 * `requires` and `ensures` are arrays, and an element that lifts to `undefined` is a claim with no
 * content. Keeping a hole in the list would make `canFollow` compare against nothing and report a
 * precondition as met by a claim that says nothing at all.
 */
const ExpectListSchema = z
  .array(ExpectSchema)
  .transform((list) => list.filter((one): one is Predicate => one !== undefined));

/** One step of a flow: an anchored action (+ optional expectation). */
export interface FlowStep {
  /** FlowStepTool.ACT | FlowStepTool.ACT_SEQUENCE (core, shared with ReticleTool). */
  tool: string;
  anchor: FlowAnchor;
  /**
   * Where this step's element came from in the source, when the build stamped one.
   *
   * Beside the anchor rather than inside it: only a COMPONENT anchor had room for a source, and a
   * recorder prefers a TESTID anchor whenever the element has one — so the commonest flow could
   * never say which files it covers, and a scoped re-verify had nothing to scope by.
   */
  source?: { file: string; line?: number };
  /**
   * A name for this step that survives editing the flow.
   *
   * Resume targets a step, and targeting it by POSITION breaks the moment one is inserted, removed
   * or healed: "resume from 4" quietly means a different step than it did yesterday, and nothing
   * reports the shift. Optional and back-compat — a flow without ids resumes by index exactly as
   * before, which is every flow recorded before this shipped.
   */
  id?: string;
  /** What this step does to the subject; absent means unknown. See StepEffect. */
  effect?: StepEffect;
  /**
   * This step sent a write request (POST, PUT, PATCH, DELETE) when it was recorded, so a replay
   * sends it again and changes real data. A certify run skips such a flow unless told otherwise.
   */
  writes?: boolean;
  action?: ActionType;
  args?: Record<string, unknown>;
  expect?: Predicate;
  /** true when the anchor is best-effort (no testid was resolvable at record time). NOT dropped. */
  degraded?: boolean;
  /**
   * This anchor was rebound by `heal`, not chosen by whoever recorded the flow.
   *
   * Without it a machine-rebound locator is byte-indistinguishable from a recorded one, and three
   * things go with that. A replay passing on a healed anchor is a weaker claim than one passing on
   * a recorded anchor, because the rebind picked the element and the consequence only checked that
   * SOMETHING still satisfied it. A step healed twice is a locator that is not stable, which was
   * unknowable because the second heal overwrote the first. And a human reading the diff saw a
   * changed testid with nothing saying who changed it.
   *
   * `from` is the ORIGINAL recorded anchor and survives later heals: the intermediate names were
   * never chosen by anybody, so keeping the newest would throw away the only one a reader wants.
   *
   * Optional and additive — a flow without it reads exactly as before, which is every flow recorded
   * until now, and no file version moves for it.
   */
  healed?: { from: string; at: number };
  /**
   * How long THIS step's `expect` waits for its consequence, in ms. Overrides the flow's
   * `signalTimeoutMs` and the built-in FLOW_SIGNAL_TIMEOUT_MS default.
   *
   * Not a tuning knob: the wait decides whether an honest flow can ever be green. A step whose
   * consequence legitimately takes longer than the default drifts with `signal_not_observed` and
   * reports a working feature as NO LONGER TRUE, and the only other ways to green it are to weaken
   * or delete the assertion, which the rules forbid.
   *
   * Replay must not be stricter than the tool that recorded the step: `act_and_wait` takes a
   * `timeout_ms`, so a recorded step can carry one too.
   */
  timeoutMs?: number;
  /** The page (route pathname) this step ran on, recorded at capture. */
  page?: string;
  /** The page it ended on once its action settled — where it led, when that differs from `page`. */
  endPage?: string;
  /** sub-steps for an act_sequence, each independently anchored. */
  steps?: FlowStep[];
  /**
   * The flow this step runs, when `tool` is `FlowStepTool.INVOKE`.
   *
   * A name, not a copy. Inlining the sub-journey's steps here would produce a composite-shaped file
   * with none of composition's value — the drift would still report a position in the outer flow,
   * repair would still have to happen in every copy, and the sub-journey could not be reused.
   */
  invoke?: string;
}

const baseFlowStep = z.object({
  tool: z.string(),
  anchor: FlowAnchorSchema,
  /**
   * Where this step's element came from in the source, when the build stamped one.
   *
   * Written alongside the anchor rather than inside it, because only a COMPONENT anchor had a place
   * for a source and a recorder prefers a TESTID anchor whenever the element has one — so the most
   * common flow in existence could never say which files it covers. `reticle_verify { action:
   * "change" }` then had nothing to scope by and re-ran the whole suite: measured on this repo's own
   * flows, 52 replayed, 46 seconds, verdict `unknown`.
   *
   * Optional, and its absence still means unknown provenance, which is still re-run by default. The
   * fail-safe must keep failing safe.
   */
  source: z
    .object({ file: z.string().min(1), line: z.number().int().positive().optional() })
    .optional(),
  /**
   * A name for this step that survives editing the flow.
   *
   * Resume targets a step, and targeting it by POSITION breaks the moment one is inserted, removed
   * or healed: "resume from 4" quietly means a different step than it did yesterday and nothing
   * reports the shift. Optional and back-compat — a flow without ids resumes by index exactly as
   * before, which is every flow recorded before this shipped.
   */
  id: z.string().min(1).optional(),
  /** What this step does to the subject; absent means unknown. See StepEffect. */
  effect: z.nativeEnum(StepEffect).optional(),
  /** Rebound by `heal` rather than recorded — see FlowStep.healed. */
  healed: z.object({ from: z.string(), at: z.number() }).optional(),
  /** See FlowStep.writes. */
  writes: z.boolean().optional(),
  action: z.nativeEnum(ActionType).optional(),
  args: z.record(z.string(), z.unknown()).optional(),
  expect: ExpectSchema.optional(),
  degraded: z.boolean().optional(),
  timeoutMs: z.number().int().nonnegative().optional(),
  invoke: z.string().min(1).optional(),
  /** See FlowStep.page / FlowStep.endPage. */
  page: z.string().optional(),
  endPage: z.string().optional(),
});

export const FlowStepSchema: z.ZodType<FlowStep> = baseFlowStep.extend({
  steps: z.lazy(() => z.array(FlowStepSchema).optional()),
}) as z.ZodType<FlowStep>;

/**
 * The on-disk flow file: diffable, git-tracked, anchor-resolved.
 * The optional `dynamic` field (both `dynamic` + `success` are optional, so a
 * file with neither still parses — back-compat is locked by a test).
 */
export const FlowFileSchema = z.object({
  /**
   * The format this file was WRITTEN in. Both readable versions are accepted, because a v1 file is
   * lifted rather than refused — see READABLE_FLOW_VERSIONS.
   */
  version: z
    .number()
    .int()
    .refine((v) => READABLE_FLOW_VERSIONS.has(v)),
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
   * True when `intent` was built from the steps' expects, not declared by anybody. An auto-saved
   * drive with no declared intent was named by its request path and read as nothing. A built
   * sentence names it, and this flag keeps it out of the intent ledger: it describes the steps, so
   * it can never be a goal the steps then prove.
   */
  intentDerived: z.boolean().optional(),
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
  /**
   * The saved flow this one was generated from, with different parameters (a fixture's customer,
   * a seeded id). A suite that writes runtime copies of a template and deletes them after replay
   * proved the template, and a strict pass of a copy counts toward it in the gate (#1321).
   */
  template: z.string().min(1).optional(),
  // FUTURE: fixtures/preconditions — schema slot reserved, unpopulated this cut. The recorder
  // never writes it and no fixture runner exists.
  fixture: z.string().optional(),
  /**
   * What must already be true for this flow to mean anything, and what it leaves true.
   *
   * These are the two halves of composition. Replaying flows back to back only works when the state
   * one leaves is the state the next expects, and nothing said so — so a suite either got lucky or
   * produced a failure that looked like a regression and was a missing precondition. `requires` lets
   * a replay report THAT instead: not met is `unknown` (nothing ran, nothing proved), never a
   * failure, which is the same honesty rule an uncovered change already follows.
   *
   * `ensures` is the other side, and is what makes A-then-B checkable before either runs.
   *
   * Both optional and both absent from every flow recorded before this shipped, where absent means
   * what it has always meant: replay from wherever the app already is, and let the steps speak.
   * Same predicate shape as a step's `expect`, deliberately — a precondition is just a consequence
   * somebody else's flow was responsible for.
   */
  requires: ExpectListSchema.optional(),
  ensures: ExpectListSchema.optional(),
  /**
   * Who made this flow, stamped at save: the agent that drove it (its MCP client name) and the
   * person signed in to the cloud key on that machine. Either is absent when it was not known —
   * never guessed.
   */
  author: z
    .object({ agent: z.string().min(1).optional(), person: z.string().min(1).optional() })
    .optional(),
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
  success: ExpectSchema.optional(),
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
   * What this flow has learned from being run, as opposed to what a person wrote on it.
   *
   * Distinct from `knownBugs` above, and the difference is who is speaking. A known bug is a HUMAN
   * excusing a failing assertion with a traceable id. A learned guard is the SYSTEM remembering a
   * defect it observed: `open` while the defect is still happening, `guarded` once a run stopped
   * showing it. Only the second state asserts anything, and its return is a regression.
   *
   * The ordering is the safety property. A contradiction seen right now is not an assertion:
   * asserting "must not happen" while it happens makes the flow red over an accepted defect and
   * trains the reader to ignore it, and asserting "does happen" pins broken behaviour so the check
   * fires when somebody FIXES the bug. See `learnFromRun` in the engine for the rule.
   */
  learned: z
    .array(
      z.object({
        kind: z.string().min(1),
        /*
         * A step index, or -1 for a finding that belongs to no single step.
         *
         * `-1` is the address this repo already uses for a whole-span contradiction (see
         * `decision.ts`), and declaring it `nonnegative()` here made the first cross-step finding
         * write a flow file that could never be loaded again — the narrow writer does not validate,
         * `load` does, and the flow was lost permanently to what read like user corruption.
         *
         * `min(-1)` rather than any negative number: -1 is a convention somebody chose, and -2 is a
         * bug arriving as data.
         */
        step: z.number().int().min(CROSS_STEP_ADDRESS),
        state: z.enum(['open', 'guarded']),
        /** Consecutive runs that did not show it. One quiet run is not a fix; see learnFromRun. */
        cleanRuns: z.number().int().nonnegative().optional(),
      }),
    )
    .optional(),
  /**
   * Bugs this flow is KNOWN to expose, so a red for a filed reason is not re-investigated.
   *
   * Without it, a suite red for a known cause is indistinguishable from one that just broke: either
   * somebody re-opens an investigation into a bug already filed, or the flow gets quarantined and
   * stops watching the rest of the journey it covers.
   *
   * `assertions` is what keeps the note honest. A known-bug note is a claim about code, and code
   * moves; a note recorded against assertions that have since changed explains away a NEW failure
   * with an OLD excuse, which is a false green in a different costume. `staleKnownBugs` reports any
   * note whose assertions no longer all exist, rather than trusting it.
   */
  knownBugs: z
    .array(
      z.object({
        /** Required: an unattributable excuse is worse than none. An issue key, a URL, anything traceable. */
        id: z.string().min(1),
        summary: z.string().min(1),
        /** Which of this flow's assertions the note was written against. */
        assertions: z.array(z.string()),
      }),
    )
    .optional(),
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
  /** Saved time, used to put recent flows first in the HUD. Older flow stores may omit it. */
  createdAt?: number;
}

/** One recorded known bug, as stored on a flow. */
export type KnownBug = NonNullable<FlowFile['knownBugs']>[number];

/**
 * Known-bug notes that can no longer be believed.
 *
 * A note survives only while EVERY assertion it named is still present. Anything else — an
 * assertion renamed, removed, or a note that named none at all — is reported rather than trusted,
 * because the failure mode is silent and expensive: an old excuse attached to a new break reads as
 * "known issue" and nobody looks again.
 *
 * A note naming no assertions is always stale. It cannot be checked against anything, so it cannot
 * be relied on to explain anything.
 */
export function staleKnownBugs(
  notes: readonly KnownBug[] | undefined,
  currentAssertions: readonly string[],
): KnownBug[] {
  const present = new Set(currentAssertions);
  return (notes ?? []).filter(
    (note) => 0 === note.assertions.length || !note.assertions.every((a) => present.has(a)),
  );
}

/** True when a FlowExpect asserts at least one consequence (any of the ConsequenceKind fields set). */
export function flowExpectHasConsequence(expect: Predicate | undefined): boolean {
  return expectClauses(expect).some(
    (clause) =>
      CONSEQUENCE_KINDS.has(clause.kind) ||
      (PredicateKind.COMPARE === clause.kind &&
        (isConsequenceSource(clause.left) || isConsequenceSource(clause.right))),
  );
}

/**
 * True when a FlowExpect checks ONLY presence — an element, rendered text or a route, no consequence.
 *
 * `text` counts here for the same reason `element` does, and leaving it out would have been the
 * expensive kind of omission: a text-only expect would have been neither a consequence nor
 * presence-only, so it would have fallen through to `assertion-free` — a permanent green wearing
 * an assertion (#811). `route` is here for exactly that reason and no other.
 *
 * PRESENCE rather than a consequence, deliberately, and it is a close call. A route change is
 * observed on a channel rather than queried from the DOM, so unlike `element` it cannot be
 * satisfied by a healed-but-wrong locator — an argument for promoting it. What settles it the other
 * way is that the LIVE verdict already grades a route assertion `presence`, and one of the two had
 * to follow the other: a flow that graded stronger on disk than the drive that produced it would be
 * a saved claim nobody made. Promoting both is a defensible change and a separate one, with the
 * false-green question — can the route commit while the view does not render? — answered first.
 */
export function flowExpectIsPresenceOnly(expect: Predicate | undefined): boolean {
  if (expect === undefined || flowExpectHasConsequence(expect)) return false;
  // A `compare` reaching here reads text on both sides, which is two readings of the same DOM.
  return expectClauses(expect).some(
    (clause) => PRESENCE_GRADED.has(clause.kind) || PredicateKind.COMPARE === clause.kind,
  );
}

/**
 * Every clause an expectation contains, composites flattened.
 *
 * The grade is about what a flow CAN prove, so a consequence buried in an `allOf` counts exactly as
 * much as one at the top. It got simpler with the tree rather than harder: the old version had to
 * probe a struct for one key per kind, and a predicate carries its kind on itself.
 */
function expectClauses(expect: Predicate | undefined): readonly Predicate[] {
  if (expect === undefined) return [];
  if (PredicateKind.ALL_OF === expect.kind || PredicateKind.ANY_OF === expect.kind) {
    return expect.predicates.flatMap(expectClauses);
  }
  if (PredicateKind.NOT === expect.kind) return expectClauses(expect.predicate);
  return [expect];
}
