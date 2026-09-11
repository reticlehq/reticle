import { ElementState } from '@reticlehq/core';
import { asRecord } from './tools-helpers.js';

/** One candidate the browser returned for a target query. */
interface TargetCandidate {
  ref?: unknown;
  role?: unknown;
  name?: unknown;
  visible?: unknown;
  states?: unknown;
}

/** What the resolution produced: a ref to act on, a document-key press, or the reason there isn't one. */
export type TargetResolution =
  | { readonly kind: 'ref'; readonly ref: string }
  | { readonly kind: 'global'; readonly ref: '' }
  | { readonly kind: 'error'; readonly message: string };

/**
 * Roles that usually name the control an agent meant, ahead of a wrapping `generic` that
 * happened to inherit the same accessible name (header CTA vs empty-state CTA).
 */
const ROLE_RANK: Readonly<Record<string, number>> = {
  button: 0,
  link: 1,
  menuitem: 2,
  tab: 3,
  checkbox: 4,
  radio: 5,
  switch: 6,
  option: 7,
  combobox: 8,
  textbox: 9,
  searchbox: 10,
};

function roleRank(role: unknown): number {
  if ('string' !== typeof role) return 100;
  return ROLE_RANK[role] ?? 50;
}

function statesOf(c: TargetCandidate): readonly string[] {
  return Array.isArray(c.states) ? c.states.filter((s): s is string => 'string' === typeof s) : [];
}

function inViewport(c: TargetCandidate): boolean {
  return statesOf(c).includes(ElementState.IN_VIEWPORT);
}

/**
 * Stable ranking for the refusal message only. Never used to pick — an action must not guess.
 *
 * Order: in-viewport over off-screen, then more-specific roles over `generic`. Visibility is
 * already applied before this runs (hidden duplicates are filtered), so it is not a sort key here.
 */
function compareCandidates(a: TargetCandidate, b: TargetCandidate): number {
  const viewport = Number(inViewport(b)) - Number(inViewport(a));
  if (0 !== viewport) return viewport;
  return roleRank(a.role) - roleRank(b.role);
}

/**
 * Annotate where the candidate sits. `anyInViewport` is true when at least one sibling carried
 * `inViewport` — only then is absence meaningful as off-screen. Without that signal, saying
 * "off-screen" would invent a fact the descriptor never reported.
 */
function formatCandidate(c: TargetCandidate, anyInViewport: boolean): string {
  const role = 'string' === typeof c.role ? c.role : '?';
  const name = 'string' === typeof c.name ? c.name : '';
  const ref = 'string' === typeof c.ref ? c.ref : '?';
  const visible = false !== c.visible;
  let where: string;
  if (!visible) where = 'hidden';
  else if (inViewport(c)) where = 'in-viewport';
  else if (anyInViewport) where = 'off-screen';
  else where = 'visible';
  const head = name.length > 0 ? `${ref} (${role} "${name}"` : `${ref} (${role}`;
  return `${head}; ${where})`;
}

/**
 * Turn a target QUERY into the single ref an action can be performed on.
 *
 * `act_and_wait` took only a `ref`, so every verification cost a `reticle_query` turn first just to
 * learn one string. The advertised tool surface is re-sent on every turn, so that extra turn was not
 * a small cost: measured on the wire, a two-turn verification spent 10,756 of its 11,235 tokens on
 * schema and 479 on the actual answers. Removing the turn removes half the schema bill.
 *
 * Ambiguity is an ERROR, never a pick. Choosing "the first match" would let a verification act on a
 * different element than the author meant and still report success, which is the false green this
 * product exists to prevent — and the failure is invisible, because the verdict describes the
 * element it DID act on. The message names the candidates so the caller can narrow rather than guess.
 *
 * Invisible matches are filtered before counting: a hidden duplicate is a common way for a
 * legitimately unambiguous query to look ambiguous, and refusing on it would push callers back to
 * the two-turn path for no gain.
 *
 * When several remain, they are ranked (in-viewport, then role) inside the refusal only — so the
 * agent can pass the top ref on the next turn without a snapshot. Ranking is never acted on here.
 */
export function resolveTargetRef(candidates: readonly unknown[]): TargetResolution {
  const all = candidates.map((c) => asRecord(c) as TargetCandidate);
  const visible = all.filter((c) => c.visible !== false);
  const usable = visible.length > 0 ? visible : all;

  if (0 === usable.length) {
    return {
      kind: 'error',
      message:
        'target matched no element. Nothing was acted on and no verdict is possible — widen the ' +
        'query, or take a reticle_snapshot to see what is actually on the page.',
    };
  }
  if (usable.length > 1) {
    const ranked = [...usable].sort(compareCandidates);
    const anyInViewport = ranked.some(inViewport);
    const named = ranked
      .slice(0, 5)
      .map((c) => formatCandidate(c, anyInViewport))
      .join(', ');
    return {
      kind: 'error',
      message:
        `target matched ${String(usable.length)} elements and an action must not guess between ` +
        `them (ranked: in-viewport, then role): ${named}. Narrow the query (add role/name/testid ` +
        'or a scope), or pass an explicit `ref` from reticle_query.',
    };
  }
  const only = usable[0];
  const ref = only === undefined ? undefined : only.ref;
  if ('string' !== typeof ref || 0 === ref.length) {
    return { kind: 'error', message: 'target matched an element with no usable ref.' };
  }
  return { kind: 'ref', ref };
}
