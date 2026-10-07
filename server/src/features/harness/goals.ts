/**
 * The goals a drive was asked to prove, and whether it did.
 *
 * A drive asked to "check that "Ada Lovelace" and "Grace Hopper" are listed" replayed old journeys,
 * dismissed a reminder and reported `finished` without looking for either name (#1316). The driver's
 * word for it is not evidence, so after every drive the harness checks each goal itself, with the
 * same assert any agent would make, and reports one verdict per goal.
 */
import { PredicateKind, ReticleTool, Verified, asRecord } from '@reticlehq/core';

/** More than this and the persona is a document, not a set of goals. */
const MAX_GOALS = 10;
const MAX_GOAL_LENGTH = 200;

/** A string the persona quoted: "straight" or “curly”. Single quotes are apostrophes too often. */
const QUOTED = /"([^"\n]{1,200})"|“([^”\n]{1,200})”/g;

export interface GoalCheck {
  /** The text that had to be on the page. */
  text: string;
  /** The engine's verdict on it: only `yes` is proved. */
  verified: string;
}

/** The observable goals in a persona: whatever it quoted. */
export function goalsIn(persona: string | undefined): string[] {
  if (persona === undefined) return [];
  const found = [...persona.matchAll(QUOTED)].map((m) => (m[1] ?? m[2] ?? '').trim());
  return [...new Set(found.filter((g) => 0 < g.length))].slice(0, MAX_GOALS);
}

/**
 * Check each goal on the page the drive ended on, recording ONE assert for the drive.
 *
 * Each quote used to be its own assert, and every assert is a check in the drive's run, so a goal
 * that quotes where it starts ("from "Count is 0" to "Count is 1"") recorded a "no" for the start
 * text a working app had rightly replaced, and the run synced as a failing flow. The page is read
 * once to answer each quote; the one recorded assert covers the quotes shown, or all of them when
 * none is, so a goal the page never reached still leaves a failed check behind. A check that cannot
 * run is `unknown`, never skipped.
 */
export async function checkGoals(
  invoke: (name: string, args: Record<string, unknown>) => Promise<unknown>,
  goals: readonly string[],
): Promise<GoalCheck[]> {
  const texts = [
    ...new Set(goals.slice(0, MAX_GOALS).map((g) => g.trim().slice(0, MAX_GOAL_LENGTH))),
  ].filter((t) => 0 < t.length);
  if (0 === texts.length) return [];
  let page: string | undefined;
  try {
    const tree = asRecord(await invoke(ReticleTool.SNAPSHOT, { mode: SNAPSHOT_FULL }))['tree'];
    if ('string' === typeof tree) page = tree;
  } catch {
    /* unread: every quote rests on the assert below */
  }
  const shown = texts.filter((t) => true === page?.includes(t));
  const recorded = 0 < shown.length ? shown : texts;
  let verified: string = Verified.UNKNOWN;
  try {
    const result = asRecord(await invoke(ReticleTool.ASSERT, { predicate: allOf(recorded) }));
    if ('string' === typeof result['verified']) verified = result['verified'];
  } catch {
    /* stays unknown: the goal was not proved */
  }
  // A quote the page read did not show is a "no" only beside one it did: with none shown, every
  // quote rests on the recorded assert.
  return texts.map((text) => ({
    text,
    verified: 0 === shown.length || shown.includes(text) ? verified : Verified.NO,
  }));
}

const SNAPSHOT_FULL = 'full';

function allOf(texts: readonly string[]): Record<string, unknown> {
  const each = texts.map((contains) => ({ kind: PredicateKind.TEXT, contains }));
  return 1 === each.length ? (each[0] ?? {}) : { kind: PredicateKind.ALL_OF, predicates: each };
}

/** One line naming the goals the drive did not prove, or undefined when it proved them all. */
export function unprovedGoals(checks: readonly GoalCheck[]): string | undefined {
  const missed = checks.filter((c) => Verified.YES !== c.verified);
  if (0 === missed.length) return undefined;
  return (
    `Not proved: ${missed.map((c) => `"${c.text}" (${c.verified})`).join(', ')}. ` +
    'The drive did not finish the job it was given, whatever its own account says.'
  );
}
