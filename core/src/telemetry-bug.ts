/**
 * The `bug_found` event: how Reticle found a defect, and who caused it. Split out of `telemetry.ts`
 * as its own subject, and re-exported from there, so every `@reticlehq/core/telemetry` import still
 * reaches it.
 */
import * as z from 'zod';

/**
 * How Reticle came to find a defect. Four routes, in descending order of "a human would have missed
 * this": a contradiction is invisible to someone watching the screen, a crawl finding required no
 * script at all, a replay failure is a regression on something that used to work, and a failed
 * assertion is the agent's own check not holding.
 */
export const BugSource = {
  /** Channels disagreed — the false green. A passing screen sitting on a failed write. */
  CONTRADICTION: 'contradiction',
  /** `reticle_crawl` found it autonomously, with nobody writing a test. */
  CRAWL: 'crawl',
  /** A saved flow that used to pass stopped passing — a regression. */
  REPLAY: 'replay',
  /** An assertion the agent declared did not hold. */
  ASSERTION: 'assertion',
} as const;
export type BugSource = (typeof BugSource)[keyof typeof BugSource];

/**
 * WHOSE fault the defect was.
 *
 * `bugsFound` is not publishable without this, and a count confidently wrong about whose fault
 * something is, is worse than no count: it points at the customer. Two rules keep it honest:
 *
 * 1. **Always present.** `UNCLASSIFIED` is a value, not a gap. Absence would mean an old sender or a
 *    path that forgot; a value means the classifier ran and declined.
 * 2. **`APP` requires POSITIVE evidence** — something the app itself did: a request that came back
 *    failed, a signal the app fired carrying data that disagrees with its own screen, a written
 *    field echoed back changed. Never "nothing else explained it". Core already draws exactly this
 *    line for the verdict, in `ABSENCE_DERIVED_CONTRADICTIONS`, and that is the line reused rather
 *    than a second judgement invented beside it.
 */
export const BugAttribution = {
  /** A defect in the app under test — the only bucket that belongs in a published defect count. */
  APP: 'app',
  /** The agent's own call was wrong: a path, store or target that never existed. Teach the agent. */
  REQUEST: 'request',
  /** Reticle could not see or could not drive. Our bug, or our configuration. Ship a fix. */
  RETICLE: 'reticle',
  /**
   * The classifier looked and the evidence could not say.
   *
   * The honest majority, and it must stay a value rather than becoming a gap: a failed
   * `element.present` covers "the button is missing", "the API is down" and "the agent mistyped a
   * testid" identically, and an owner invented for it would put a guess into a published number.
   * Exclude it from a defect count; never fold it into `app`.
   */
  UNCLASSIFIED: 'unclassified',
} as const;
export type BugAttribution = (typeof BugAttribution)[keyof typeof BugAttribution];

/**
 * One defect Reticle found in the app under test.
 *
 * `kind` is the taxonomy value from `findings.ts` — `signal-contradicted`, `console-error`,
 * `duplicate-request` and so on. Never a selector, a URL, an element, or any description of the
 * user's app — THAT a class of defect was found, never WHAT it was in.
 */
export const BugFoundSchema = z.object({
  source: z.nativeEnum(BugSource),
  /** The classified kind from Reticle's own findings vocabulary. */
  kind: z.string().min(1).max(64),
  /**
   * True when the defect PRESENTED AS SUCCESS — the screen advanced, the assertion passed, the click
   * looked fine — while another channel showed it had not.
   *
   * Defined by the presentation rather than by "an assertion passed", because the same defect arrives
   * both ways: through `reticle_assert` there IS a passing assertion to contradict, and through
   * `reticle_crawl` there is no assertion at all and the UI simply moved on over a failed write. Both
   * are the thing a human watching the screen cannot see, and that is what the flag has to mean if
   * the number is going to be published.
   *
   * The subset worth naming separately, because it is the only category Reticle can claim as uniquely
   * its own: every other kind of bug is findable by a careful human or an ordinary test.
   */
  falseGreen: z.boolean(),
  /** Which tool surfaced it. */
  tool: z.string().min(1).max(64).optional(),
  /**
   * TRUE when this KIND was already reported in this session — i.e. this is another INSTANCE of a
   * defect already counted, not another defect.
   *
   * Both numbers are claims, and they are different ones. "Reticle found N defects" is the headline;
   * "users hit them M times" is the frequency that says which ones actually cost anybody anything.
   * Without this flag the event stream answers only the second while looking like it answers the
   * first, so any distinct-defect count read off it is silently inflated — the exact way a published
   * number goes wrong. Count `repeat: false` for distinct, count everything for instances.
   *
   * Scoped to the SESSION, because that is the only identity available: the payload deliberately
   * carries no selector, URL or app detail, so the same defect in two sessions cannot be recognised
   * as one — and must not be, since that would need data this event refuses to collect.
   */
  repeat: z.boolean(),
  /**
   * Whose fault it was, ALWAYS present — `unclassified` when the evidence cannot say, never absent.
   *
   * Absence and "the evidence could not say" are different facts, and only one of them is a
   * measurement. Count `attribution: 'app'` for defects found in anybody's product; see
   * `BugAttribution` for why `app` needs positive evidence.
   */
  attribution: z.nativeEnum(BugAttribution),
  /**
   * A stable hash identifying THIS defect across sessions — same kind at the same route = same
   * fingerprint, regardless of when or where it was found.
   *
   * The inputs (route, selector) never travel raw — only the 8-char hex hash does, following the
   * same privacy pattern as `projectId`. The analytics side groups on it to answer "was this bug
   * fixed?" (the fingerprint stops appearing) and to deduplicate the same defect found by parallel
   * agents in one run.
   *
   * OPTIONAL because old senders and the `reticle verify` CLI path do not yet compute it. Absent
   * means "not fingerprinted", never "a different defect from one that has a fingerprint".
   */
  fingerprint: z.string().max(16).optional(),
  /**
   * Which hit of this `fingerprint` in the session, from 1. Two hits of one defect used to be
   * byte-identical rows, so a duplicated delivery and a real second hit could not be told apart.
   * `occurrence: 1` is the distinct defect within a session. Absent on older senders.
   */
  occurrence: z.number().int().positive().optional(),
});
export type BugFound = z.infer<typeof BugFoundSchema>;
