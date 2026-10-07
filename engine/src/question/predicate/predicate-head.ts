/**
 * The `head` predicate (#1425): a `<link>` or `<meta>` in the live `<head>`, read through HEAD_READ.
 *
 * Every way of not knowing is `inconclusive`, never a failure: a page whose SDK predates the command,
 * an answer cut off before the tag could have appeared, a value redacted before it left the page.
 * Each of those is a fact about what Reticle could see, not about the app, and reporting one as a
 * defect would send an agent to fix code that works.
 */
import type { z } from 'zod';
import { HeadSnapshotSchema, PredicateKind, REDACTED_VALUE, ReticleCommand } from '@reticlehq/core';
import type { EvalResult, Predicate } from './predicate-eval.js';
import type { PredicateSession } from './predicate-session.js';

// Both derived rather than imported: the schema and the predicate are already borrowed, and a name
// borrowed for nothing but its type is one more for core-coupling-only-shrinks to count.
type HeadPredicate = Extract<Predicate, { kind: typeof PredicateKind.HEAD }>;
type HeadValue = NonNullable<HeadPredicate['href']>;
type HeadSnapshot = z.infer<typeof HeadSnapshotSchema>;

const PRESENT = 'head.present';
const ABSENT = 'head.absent';
/** How many existing tags a failure names. Enough to spot a typo; not the whole head. */
const NAMED_IN_A_MISS = 5;

/** One tag of the kind asked for, reduced to what the predicate compares. */
interface Tag {
  /** The value the predicate's `href`/`content` is checked against. */
  readonly value: string;
  /** Not the page's exact text: redacted, summarized or capped before it left the page. */
  readonly altered: boolean;
  readonly evidence: HeadSnapshot['links'][number] | HeadSnapshot['metas'][number];
}

interface Side {
  /** `<link rel="icon">`, `<meta name="description">` — the tag as a person would write it. */
  readonly label: string;
  /** Tags of this kind that match the selector (`rel` token, `name`, `property`). */
  readonly tags: readonly Tag[];
  /** Every tag of this kind in the head, named by its selector, for a miss to list. */
  readonly present: readonly string[];
  readonly want: HeadValue | undefined;
  readonly field: 'href' | 'content';
}

const lower = (value: string | undefined): string => (value ?? '').toLowerCase();

/** `rel` is a token list: "shortcut icon" is an icon, "apple-touch-icon" is not. */
function relHas(rel: string, token: string): boolean {
  return lower(rel).split(/\s+/).includes(lower(token));
}

function sideOf(p: HeadPredicate, head: HeadSnapshot): Side {
  if (p.link !== undefined) {
    const rel = p.link.rel;
    return {
      label: `<link rel="${rel}">`,
      tags: head.links
        .filter((link) => relHas(link.rel, rel))
        .map((link) => ({ value: link.href, altered: isAltered(link), evidence: link })),
      present: head.links.map((link) => link.rel),
      want: p.href,
      field: 'href',
    };
  }
  const by = p.meta?.name !== undefined ? 'name' : 'property';
  const key = p.meta?.name ?? p.meta?.property ?? '';
  return {
    label: `<meta ${by}="${key}">`,
    tags: head.metas
      .filter((meta) => lower(meta[by]) === lower(key))
      .map((meta) => ({ value: meta.content, altered: isAltered(meta), evidence: meta })),
    present: head.metas.map((meta) => meta.name ?? meta.property ?? ''),
    want: p.content,
    field: 'content',
  };
}

/** The SDK's flag, or the marker itself from an SDK that predates the flag. */
function isAltered(tag: {
  altered?: boolean | undefined;
  href?: string;
  content?: string;
}): boolean {
  return true === tag.altered || REDACTED_VALUE === (tag.href ?? tag.content);
}

/**
 * Whether the tag's value proves the check. An altered value proves a substring the part that is
 * still visible contains, and nothing else: equality with text that is no longer all there cannot
 * be shown, and a substring that is not visible may be in the part that was removed.
 */
function holds(tag: Tag, want: HeadValue): boolean {
  if ('contains' in want) return tag.value.includes(want.contains);
  return !tag.altered && tag.value === want.equals;
}

function described(want: HeadValue): string {
  return 'contains' in want ? `containing "${want.contains}"` : `equal to "${want.equals}"`;
}

function inconclusive(reason: string): EvalResult {
  return { pass: false, failureReason: reason, inconclusive: reason };
}

export async function evalHead(session: PredicateSession, p: HeadPredicate): Promise<EvalResult> {
  const res = await session.command(ReticleCommand.HEAD_READ, {});
  if (!res.ok) {
    return inconclusive(
      `the page could not read its <head> (${res.error ?? 'no reason given'}); an SDK older than ` +
        'the head predicate does not answer it, so update @reticlehq/browser',
    );
  }
  const parsed = HeadSnapshotSchema.safeParse(res.result);
  if (!parsed.success) {
    return inconclusive('the page answered HEAD_READ with something that is not a head snapshot');
  }
  const head = parsed.data;
  const side = sideOf(p, head);
  const expected =
    side.want === undefined
      ? side.label
      : `${side.label} with ${side.field} ${described(side.want)}`;
  const want = side.want;
  const matches = want === undefined ? side.tags : side.tags.filter((tag) => holds(tag, want));
  // Tags that did not prove the check only because their value was altered: what is missing from
  // them could have been exactly what was asked for.
  const unsure = side.tags.filter((tag) => tag.altered && !matches.includes(tag)).length;
  const cutOff = true === head.truncated;

  if (matches.length > 0) {
    if (true !== p.absent) return { pass: true, evidence: matches.map((tag) => tag.evidence) };
    return {
      pass: false,
      failureReason: `${expected} is in the head, and it must not be`,
      observed: `${String(matches.length)} matching tag(s) in the head`,
      expected: `no ${expected}`,
      assertion: ABSENT,
      evidence: matches.map((tag) => tag.evidence),
    };
  }
  // Nothing matched. Whether that is a finding depends on whether the whole head was readable.
  if (unsure > 0) {
    return inconclusive(
      `${side.label} is in the head, but its ${side.field} was redacted or shortened before it left ` +
        'the page, so the full value cannot be checked',
    );
  }
  if (cutOff) {
    return inconclusive(
      `the head was cut off at the read limit before ${side.label} was found; it may be further down`,
    );
  }
  if (true === p.absent) return { pass: true };
  const observed =
    side.tags.length > 0
      ? `${side.label} has ${side.field} ${side.tags
          .slice(0, NAMED_IN_A_MISS)
          .map((tag) => `"${tag.value}"`)
          .join(', ')}`
      : `no ${side.label} in the head; present: ${side.present.slice(0, NAMED_IN_A_MISS).join(', ') || 'none'}`;
  return {
    pass: false,
    failureReason: `no ${expected} in the head`,
    observed,
    expected,
    assertion: PRESENT,
  };
}
