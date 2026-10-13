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
 * at the previous quote or clause end, so `doesn't show "X" until you click "Y"` negates X only. A
 * comma ends the clause too: "place the order without the coupon, ending on "Order confirmed"" read
 * its end as text that must be absent, and the journey failed with no goal to reach.
 */
const NEGATED_BEFORE = /(?:\b(?:not|never|no|nor|without|no longer)|n't)\b[^"“”.,;!?]{0,40}$/i;

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

/** Said of a goal the page showed when looked at, which the text check nonetheless did not find. */
const SHOWN_NOT_HELD = `${VerifiedReason.INCONCLUSIVE}: shown on the page when looked at, but the text check did not find it (a field's value, or text it cannot read)`;

/** Said of an absence goal beside a goal the drive never reached: absent from the wrong page proves nothing. */
const ABSENCE_UNREACHED = `${VerifiedReason.INCONCLUSIVE}: the drive did not reach the page it ends on, so its absence there proves nothing`;

/** How the snapshot and the element reader end a text they cut short. */
const CUT = '…';
const collapse = (text: string): string => text.replace(/\s+/g, ' ').trim();

/**
 * Whether `shown` — one element's text, maybe cut short with "…" — is text the Harness wrote itself
 * rather than the app: one of `own` (its journey, the names of the plan and the flows it saved), in
 * full or cut short, holding `goal`. A Harness asked to rename a plan stopped on the /plans list and
 * was graded PROVED on every quote: the plan it had just saved was named after the journey, and the
 * journey quoted them all. An element showing exactly the goal is the app's, whoever else wrote it.
 */
export function writtenByHarness(shown: string, goal: string, own: readonly string[]): boolean {
  const full = collapse(shown);
  const cut = full.endsWith(CUT);
  const text = cut ? full.slice(0, -CUT.length).trimEnd() : full;
  const wanted = collapse(goal);
  if (text.length <= wanted.length) return false;
  return own.some((o) => {
    const mine = collapse(o);
    if (0 === mine.length || !mine.includes(wanted)) return false;
    if (cut && mine.startsWith(text)) return true;
    // Its own text first ("<journey> and 5 more"): what follows it is not the Harness's.
    return text.startsWith(mine) && !text.slice(mine.length).includes(wanted);
  });
}

/**
 * Whether a snapshot shows `goal` anywhere but inside text the Harness wrote itself. Read as text,
 * not parsed: the journey quotes its goals, so its quotes cut a parsed name short.
 */
function shownByApp(tree: string, goal: string, own: readonly string[]): boolean {
  const wanted = collapse(goal);
  const mine = own.map(collapse).filter((o) => wanted.length < o.length && o.includes(wanted));
  if (0 === mine.length) return tree.includes(goal);
  return tree.split('\n').some((line) => {
    let rest = collapse(line);
    for (const o of mine) {
      rest = rest.split(o).join('');
      rest = withoutCutStart(rest, o, wanted.length);
    }
    return rest.includes(wanted);
  });
}

/** `line` without each start of `own` the snapshot cut short with "…" (longer than `min`). */
function withoutCutStart(line: string, own: string, min: number): string {
  let rest = line;
  for (let at = rest.indexOf(CUT); -1 !== at; at = rest.indexOf(CUT, at + 1)) {
    const before = rest.slice(0, at);
    for (let n = Math.min(own.length, before.length); min < n; n -= 1) {
      if (!before.endsWith(own.slice(0, n))) continue;
      rest = `${rest.slice(0, at - n)}${rest.slice(at + CUT.length)}`;
      at -= n;
      break;
    }
  }
  return rest;
}

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
  /** Text the Harness wrote itself (its journey, its plan's and flows' names): never evidence. */
  own: readonly string[] = [],
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
    if ((await scrolledTo(invoke, g.text, own)) || shownByApp(page ?? '', g.text, own))
      found.add(g.text);
  }
  const unreached = todo.some((g) => true !== g.absent && !found.has(g.text));
  const absences = unreached ? [] : todo.filter((g) => true === g.absent);
  const recorded = [...todo.filter((g) => found.has(g.text)), ...absences];
  const verified: string =
    0 < recorded.length ? await assertGoals(invoke, recorded) : Verified.UNKNOWN;
  // One joint check that failed says only that SOMETHING did not hold: each goal is asked on its own,
  // so a goal that held is not graded "no" for a neighbour that did not.
  const each = new Map<string, string>();
  if (Verified.NO === verified && 1 < recorded.length)
    for (const g of recorded) each.set(g.text, await assertGoals(invoke, [g]));
  const verdictOf = (g: Goal): string => each.get(g.text) ?? verified;
  return all.map((g) => {
    if (before.has(g.text)) return unchecked(g, ALREADY_SHOWN);
    if (true === g.absent) {
      return unreached
        ? unchecked(g, ABSENCE_UNREACHED)
        : { text: g.text, absent: true, verified: verdictOf(g) };
    }
    if (!found.has(g.text)) return unchecked(g, NOT_REACHED);
    // Seen on the page yet the text check says no: a field's value, or text the check cannot read.
    return Verified.NO === verdictOf(g)
      ? unchecked(g, SHOWN_NOT_HELD)
      : { text: g.text, verified: verdictOf(g) };
  });
}

/** The verdict of one assert over `goals`, or unknown when it could not be asked. */
async function assertGoals(
  invoke: (name: string, args: Record<string, unknown>) => Promise<unknown>,
  goals: readonly Goal[],
): Promise<string> {
  try {
    const result = asRecord(await invoke(ReticleTool.ASSERT, { predicate: allOf(goals) }));
    return 'string' === typeof result['verified'] ? result['verified'] : Verified.UNKNOWN;
  } catch {
    return Verified.UNKNOWN;
  }
}

/**
 * Whether the page shows `text` once it has settled, scrolled to if need be — how a person looks
 * for something before saying it is not there. Records no check.
 */
export async function lookFor(
  invoke: (name: string, args: Record<string, unknown>) => Promise<unknown>,
  text: string,
  /** Text the Harness wrote itself: a match inside it is not the page showing the goal. */
  own: readonly string[] = [],
): Promise<boolean> {
  await settle(invoke);
  if (shownByApp((await readOpening(invoke)) ?? '', text, own)) return true;
  return scrolledTo(invoke, text, own);
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

/**
 * Bring a goal's text into view, the way a person scrolls to it. True when it was found, and not
 * inside text the Harness wrote itself.
 */
async function scrolledTo(
  invoke: (name: string, args: Record<string, unknown>) => Promise<unknown>,
  text: string,
  own: readonly string[],
): Promise<boolean> {
  try {
    const result = asRecord(
      await invoke(ReticleTool.SCROLL_TO, {
        by: QueryBy.TEXT,
        value: text,
        maxScrolls: GOAL_SCROLLS,
      }),
    );
    const element = asRecord(result['element']);
    const shown = element['text'] ?? element['name'];
    return (
      true === result['found'] && !('string' === typeof shown && writtenByHarness(shown, text, own))
    );
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

/**
 * The goals a drive is graded on: every quote, less a value the drive typed — an input, never
 * evidence — except the journey's end (its last text to show), which stays even when typed: saving
 * "Order 7" and then seeing it listed is the journey. Absence goals always stay.
 */
export function endGoalsOf(goals: readonly Goal[], typed: readonly string[]): Goal[] {
  const end = goals.filter((g) => true !== g.absent).at(-1);
  const inputs = new Set(typed.map((t) => t.trim()));
  return goals.filter((g) => true === g.absent || g === end || !inputs.has(g.text.trim()));
}
