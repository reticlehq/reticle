/**
 * The goals a drive was asked to prove, and whether it did.
 *
 * A drive asked to "check that "Ada Lovelace" and "Grace Hopper" are listed" replayed old journeys,
 * dismissed a reminder and reported `finished` without looking for either name (#1316). The driver's
 * word for it is not evidence, so after every drive the harness checks each goal itself, with the
 * same assert any agent would make, and reports one verdict per goal.
 */
import {
  PredicateKind,
  QueryBy,
  ReticleTool,
  Verified,
  VerifiedReason,
  asRecord,
} from '@reticlehq/core';

/** More than this and the persona is a document, not a set of goals. */
const MAX_GOALS = 10;
const MAX_GOAL_LENGTH = 200;

/**
 * A string the persona quoted: "straight" or “curly”. Single quotes are apostrophes too often.
 *
 * A straight quote opens only after a space, a bracket or the start, and closes only before one or
 * before sentence punctuation, so a goal that quotes text with quotes in it — the issue title
 * `"Check failed: an element matching {"testid":"pay"}"` — stays one goal. Matching any `"` split
 * that title into `{`, `:` and `}`, and graded the fragments.
 */
const QUOTED = /(?<![^\s([])"([^\n]{1,200}?)"(?![^\s.,;!?)\]])|“([^”\n]{1,200})”/g;

/**
 * A negation in the same clause just before a quote: "must not show "payments"". The window stops
 * at the previous quote or clause end, so `doesn't show "X" until you click "Y"` negates X only.
 */
const NEGATED_BEFORE = /(?:\b(?:not|never|no|nor|without|no longer)|n't)\b[^"“”.;!?]{0,40}$/i;

/** One goal: text the page must show, or — when the persona negated it — must not. */
export interface Goal {
  text: string;
  /** The persona said the page must NOT show it: an absence goal, graded by asserting it is not there. */
  absent?: true;
}

export interface GoalCheck {
  /** The text that had to be on the page (or, for an absence goal, not on it). */
  text: string;
  /** Set for an absence goal. */
  absent?: true;
  /** The engine's verdict on it: only `yes` is proved. */
  verified: string;
  /** Why it was not checked, when it was not. */
  reason?: string;
}

/** Said of a goal the page showed before the drive did anything. */
const ALREADY_SHOWN = `${VerifiedReason.ALREADY_TRUE}: it was on the page before the drive started, so seeing it proves nothing`;

/**
 * Said of a goal the page the drive ended on never showed, even scrolled. Undecided, never `no`: the
 * drive may not have reached the page that shows it, and a "no" there blamed the app for where the
 * Harness stopped.
 */
const NOT_REACHED = `${VerifiedReason.INCONCLUSIVE}: not on the page the drive ended on, even scrolled; the drive may not have reached the page that shows it`;

/** Said of an absence goal beside a goal the drive never reached: absent from the wrong page proves nothing. */
const ABSENCE_UNREACHED = `${VerifiedReason.INCONCLUSIVE}: the drive did not reach the page it ends on, so its absence there proves nothing`;

/** The observable goals in a persona: whatever it quoted, each marked absent when it was negated. */
export function parseGoals(persona: string | undefined): Goal[] {
  if (persona === undefined) return [];
  const out = new Map<string, Goal>();
  for (const m of persona.matchAll(QUOTED)) {
    const text = (m[1] ?? m[2] ?? '').trim();
    if (0 === text.length || out.has(text)) continue;
    const absent = NEGATED_BEFORE.test(persona.slice(0, m.index));
    out.set(text, absent ? { text, absent } : { text });
  }
  return [...out.values()].slice(0, MAX_GOALS);
}

/** The texts a persona says must be on the page: the quoted goals it did not negate. */
export function goalsIn(persona: string | undefined): string[] {
  return parseGoals(persona).flatMap((g) => (true === g.absent ? [] : [g.text]));
}

/**
 * Check each goal on the page the drive ended on, recording ONE assert for the drive.
 *
 * Each quote used to be its own assert, and every assert is a check in the drive's run, so a goal
 * that quotes where it starts ("from "Count is 0" to "Count is 1"") recorded a "no" for the start
 * text a working app had rightly replaced, and the run synced as a failing flow. The page is let
 * settle, read once, and each goal is scrolled to by its text — one below the fold read `unknown`
 * on a drive that never scrolled. The one recorded assert covers the goals found. A goal not found
 * is undecided, not failed: nothing here knows the drive reached the page that would show it. A
 * check that cannot run is `unknown`, never skipped.
 */
export async function checkGoals(
  invoke: (name: string, args: Record<string, unknown>) => Promise<unknown>,
  goals: readonly (string | Goal)[],
  /** The page as it read before the drive: a goal it already showed proves nothing at the end. */
  opening?: string,
): Promise<GoalCheck[]> {
  const byText = new Map<string, Goal>();
  for (const goal of goals.slice(0, MAX_GOALS)) {
    const g = 'string' === typeof goal ? { text: goal } : goal;
    const text = g.text.trim().slice(0, MAX_GOAL_LENGTH);
    if (0 < text.length && !byText.has(text)) byText.set(text, { ...g, text });
  }
  const all = [...byText.values()];
  const before = new Set(
    all.filter((g) => true !== g.absent && true === opening?.includes(g.text)).map((g) => g.text),
  );
  const unchecked = (g: Goal, reason: string): GoalCheck => ({
    text: g.text,
    ...(true === g.absent ? { absent: true } : {}),
    verified: Verified.UNKNOWN,
    reason,
  });
  const todo = all.filter((g) => !before.has(g.text));
  if (0 === todo.length) return all.map((g) => unchecked(g, ALREADY_SHOWN));
  await settle(invoke);
  const page = await readOpening(invoke);
  const found = new Set<string>();
  for (const g of todo) {
    if (true === g.absent) continue;
    if ((await scrolledTo(invoke, g.text)) || true === page?.includes(g.text)) found.add(g.text);
  }
  const unreached = todo.some((g) => true !== g.absent && !found.has(g.text));
  const absences = unreached ? [] : todo.filter((g) => true === g.absent);
  const recorded = [...todo.filter((g) => found.has(g.text)), ...absences];
  let verified: string = Verified.UNKNOWN;
  if (0 < recorded.length) {
    try {
      const result = asRecord(await invoke(ReticleTool.ASSERT, { predicate: allOf(recorded) }));
      if ('string' === typeof result['verified']) verified = result['verified'];
    } catch {
      /* stays unknown: the goal was not proved */
    }
  }
  return all.map((g) => {
    if (before.has(g.text)) return unchecked(g, ALREADY_SHOWN);
    if (true === g.absent) {
      return unreached ? unchecked(g, ABSENCE_UNREACHED) : { text: g.text, absent: true, verified };
    }
    return found.has(g.text) ? { text: g.text, verified } : unchecked(g, NOT_REACHED);
  });
}

/**
 * Whether the page shows `text` once it has settled, scrolled to if need be — how a person looks
 * for something before saying it is not there. Records no check.
 */
export async function lookFor(
  invoke: (name: string, args: Record<string, unknown>) => Promise<unknown>,
  text: string,
): Promise<boolean> {
  await settle(invoke);
  if (true === (await readOpening(invoke))?.includes(text)) return true;
  return scrolledTo(invoke, text);
}

/** Long enough for a lazy route to render; short enough that a page that never quiets costs little. */
const SETTLE_MS = 3000;
/** Scrolls spent looking for one goal: a long page, not an endless feed. */
const GOAL_SCROLLS = 10;

/** Let a page that is still changing finish, so a view still swapping in is not read half-drawn. */
async function settle(
  invoke: (name: string, args: Record<string, unknown>) => Promise<unknown>,
): Promise<void> {
  try {
    await invoke(ReticleTool.WAIT_FOR, {
      predicate: { kind: PredicateKind.SETTLED },
      timeout_ms: SETTLE_MS,
    });
  } catch {
    /* a page that never settles is still read as it stands */
  }
}

/** Bring a goal's text into view, the way a person scrolls to it. True when it was found. */
async function scrolledTo(
  invoke: (name: string, args: Record<string, unknown>) => Promise<unknown>,
  text: string,
): Promise<boolean> {
  try {
    const result = asRecord(
      await invoke(ReticleTool.SCROLL_TO, {
        by: QueryBy.TEXT,
        value: text,
        maxScrolls: GOAL_SCROLLS,
      }),
    );
    return true === result['found'];
  } catch {
    return false;
  }
}

const SNAPSHOT_FULL = 'full';

/** The page as it reads now, or undefined when it cannot be read. Taken before a drive starts. */
export async function readOpening(
  invoke: (name: string, args: Record<string, unknown>) => Promise<unknown>,
): Promise<string | undefined> {
  try {
    const tree = asRecord(await invoke(ReticleTool.SNAPSHOT, { mode: SNAPSHOT_FULL }))['tree'];
    return 'string' === typeof tree ? tree : undefined;
  } catch {
    return undefined;
  }
}

function allOf(goals: readonly Goal[]): Record<string, unknown> {
  const each = goals.map((g) => {
    const shown = { kind: PredicateKind.TEXT, contains: g.text };
    return true === g.absent ? { kind: PredicateKind.NOT, predicate: shown } : shown;
  });
  return 1 === each.length ? (each[0] ?? {}) : { kind: PredicateKind.ALL_OF, predicates: each };
}

/**
 * The end state the caller declared, checked like any assert.
 *
 * Quoted text only proves some words are on the last page, which is how a drive that never used the
 * app could pass: from the field, "it only checks that I have certain titles on my page". An `expect`
 * names an OUTCOME — a route reached, a request made, state changed — in the same predicate grammar
 * as reticle_assert, and is graded the same way. A check that cannot run is `unknown`.
 */
export async function checkExpect(
  invoke: (name: string, args: Record<string, unknown>) => Promise<unknown>,
  predicate: Record<string, unknown>,
): Promise<GoalCheck> {
  let verified: string = Verified.UNKNOWN;
  try {
    const result = asRecord(await invoke(ReticleTool.ASSERT, { predicate }));
    if ('string' === typeof result['verified']) verified = result['verified'];
  } catch {
    /* stays unknown: the outcome was not proved */
  }
  return { text: `expect ${JSON.stringify(predicate).slice(0, MAX_GOAL_LENGTH)}`, verified };
}

/** Whether the drive met the goals it was given: undefined when it was given none. */
export function goalsMet(checks: readonly GoalCheck[]): boolean | undefined {
  return 0 === checks.length ? undefined : checks.every((c) => Verified.YES === c.verified);
}

/**
 * Whether the drive met its goal, as the answer and the run report it. The driver's own `goalMet`
 * is its word, never evidence: a run answered `goalMet: true` after zero actions on a tab that
 * already showed the end state, and another with both its goals `unknown`. With goals, met exactly
 * when every one was proved; with none, the driver's word stands, and only after an action ran.
 * Undefined when nothing judged it.
 */
export function goalOfDrive(
  claimed: boolean | undefined,
  checks: readonly GoalCheck[],
  acted: boolean,
): boolean | undefined {
  // Proved goals are the evidence: a `yes` was not on the page before the drive (that reads
  // already_true), so the run reached it, by the drive or by the hunt after it.
  if (0 < checks.length) return true === goalsMet(checks);
  return claimed === undefined ? undefined : acted && claimed;
}

/** One line naming the goals the drive did not prove, or undefined when it proved them all. */
export function unprovedGoals(checks: readonly GoalCheck[]): string | undefined {
  const missed = checks.filter((c) => Verified.YES !== c.verified);
  if (0 === missed.length) return undefined;
  return (
    `Not proved: ${missed.map((c) => `${true === c.absent ? 'no ' : ''}"${c.text}" (${c.reason ?? c.verified})`).join(', ')}. ` +
    'The drive did not finish the job it was given, whatever its own account says.'
  );
}
