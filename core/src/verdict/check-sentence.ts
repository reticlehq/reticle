/**
 * A check in a person's words.
 *
 * A check the agent recorded without an `intent` reached the platform as its predicate alone, so its
 * issue was titled with engine wording ("a request PATCH matching '/assignee'"). This builds the
 * sentence a reader opens a failed check for, from the predicate itself: what did not happen, or
 * what happened that should not have. The engine's `describeWaitTarget` stays the claim; this is
 * its title. In core so the platform can build the same sentence for a check that has none.
 */
import type { ElementQuery } from '@/wire/types.js';
import { PredicateKind } from './consequence.js';
import type { Predicate } from './predicate.js';

/** Joins the parts of a conjunction in one sentence. */
const PART_GAP = '; ';
const ALL_OF_LEAD = 'Not all of these happened: ';
const ANY_OF_LEAD = 'None of these happened: ';
const SHOULD_NOT = ', and it should not have';

/**
 * Verdict assertions that mean a call matching the method and url WAS made, and only a body clause
 * missed: the request side (what the UI sent) and the response side (what the server answered).
 */
const REQUEST_BODY_MISS: ReadonlySet<string> = new Set([
  'net.requestBody',
  'net.requestBodyMatches',
]);
const RESPONSE_BODY_MISS: ReadonlySet<string> = new Set(['net.bodyContains', 'net.bodyMatches']);

const capital = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/** The element a query names, as a noun: 'the button "Pay"', 'the element marked "x"', 'a dialog'. */
function elementNoun(query: ElementQuery): string {
  if (query.testid !== undefined) return `the element marked "${query.testid}"`;
  const named = query.name ?? query.text ?? query.label ?? query.placeholder ?? query.alt;
  if (query.role !== undefined)
    return named === undefined ? `a ${query.role}` : `the ${query.role} "${named}"`;
  if (named !== undefined) return `the element "${named}"`;
  return `an element matching ${JSON.stringify(query)}`;
}

/** What a claim is about, as a noun: "a PATCH request to /assignee", 'the text "Saved"'. */
function noun(predicate: Predicate): string {
  switch (predicate.kind) {
    case PredicateKind.NET:
      return `a ${predicate.method === undefined ? '' : `${predicate.method} `}request${
        predicate.urlContains === undefined ? '' : ` to ${predicate.urlContains}`
      }`;
    case PredicateKind.TEXT:
      return `the text "${predicate.contains ?? ''}"`;
    case PredicateKind.SIGNAL:
      return predicate.name === undefined ? 'a signal' : `the app reporting "${predicate.name}"`;
    case PredicateKind.ROUTE:
      return predicate.pathname !== undefined
        ? `a move to ${predicate.pathname}`
        : predicate.contains !== undefined
          ? `a move to an address holding "${predicate.contains}"`
          : 'a route change';
    case PredicateKind.ELEMENT:
      return elementNoun(predicate.query);
    default:
      return `a ${predicate.kind} check`;
  }
}

/** A net claim whose call was made: what it did not carry, else undefined. */
function madeWithout(predicate: Predicate, assertion: string | undefined): string | undefined {
  if (PredicateKind.NET !== predicate.kind || assertion === undefined) return undefined;
  const made = `${capital(noun(predicate))} was made, but`;
  if (REQUEST_BODY_MISS.has(assertion)) {
    const wanted = predicate.requestBodyMatches ?? predicate.requestBodyContains;
    if (wanted !== undefined) return `${made} it did not carry ${JSON.stringify(wanted)}`;
  }
  if (RESPONSE_BODY_MISS.has(assertion)) {
    const wanted = predicate.bodyMatches ?? predicate.bodyContains;
    if (wanted !== undefined) return `${made} its answer did not carry ${JSON.stringify(wanted)}`;
  }
  return undefined;
}

/** The sentence for a leaf claim that did not come true. */
function missed(predicate: Predicate, assertion?: string): string {
  switch (predicate.kind) {
    case PredicateKind.NET:
      return (
        madeWithout(predicate, assertion) ?? `No ${noun(predicate).slice('a '.length)} was made`
      );
    case PredicateKind.TEXT:
      return true === predicate.absent
        ? `${capital(noun(predicate))} appeared${SHOULD_NOT}`
        : `${capital(noun(predicate))} never appeared`;
    case PredicateKind.SIGNAL:
      return predicate.name === undefined
        ? 'The app reported no signal'
        : `The app never reported "${predicate.name}"`;
    case PredicateKind.ROUTE:
      return predicate.pathname !== undefined
        ? `The page never moved to ${predicate.pathname}`
        : predicate.contains !== undefined
          ? `The address never came to hold "${predicate.contains}"`
          : 'The route never changed';
    case PredicateKind.ELEMENT: {
      const subject = elementNoun(predicate.query);
      if (true === predicate.absent) return `${capital(subject)} appeared${SHOULD_NOT}`;
      if (predicate.state !== undefined) return `${capital(subject)} was not ${predicate.state}`;
      return subject.startsWith('a ')
        ? `No ${subject.slice('a '.length)} appeared`
        : `${capital(subject)} never appeared`;
    }
    case PredicateKind.STATE:
      return `The app's state at ${predicate.path} was not as the check expected`;
    case PredicateKind.SETTLED:
      return 'The page never went idle';
    case PredicateKind.CONSOLE:
      return true === predicate.absent
        ? `A console message appeared${SHOULD_NOT}`
        : 'No console message appeared';
    case PredicateKind.ANIMATION:
      return predicate.name === undefined
        ? 'No animation ran'
        : `The animation "${predicate.name}" never ran`;
    case PredicateKind.COMPARE:
      return `The ${predicate.left.from} and ${predicate.right.from} readings did not agree`;
    case PredicateKind.NOT:
      return `${capital(noun(predicate.predicate))} happened${SHOULD_NOT}`;
    case PredicateKind.ALL_OF:
      return `${ALL_OF_LEAD}${predicate.predicates.map(noun).join(PART_GAP)}`;
    case PredicateKind.ANY_OF:
      return `${ANY_OF_LEAD}${predicate.predicates.map(noun).join(PART_GAP)}`;
  }
}

/**
 * The check in the failure voice. With `failedPart`, an `allOf` is named by the one part that failed.
 * `assertion` is the verdict's (of that part, for an `allOf`): a body clause that missed on a call
 * that was made reads as that, not as "no request was made".
 */
export function failureSentence(
  predicate: Predicate,
  failedPart?: number,
  assertion?: string,
): string {
  if (PredicateKind.ALL_OF === predicate.kind && failedPart !== undefined) {
    const part = predicate.predicates[failedPart];
    if (part !== undefined) return failureSentence(part, undefined, assertion);
  }
  return missed(predicate, assertion);
}

/**
 * The index of the `allOf` part that failed, read from the per-part results a failed conjunction
 * keeps as its evidence. A part nobody could read is skipped: a real failure outranks it, as in the
 * evaluation. Undefined for a pass, a leaf, an `anyOf` (every part failed) or evidence it cannot read.
 */
export function failedPartOf(predicate: Predicate, evidence: unknown): number | undefined {
  if (PredicateKind.ALL_OF !== predicate.kind || !Array.isArray(evidence)) return undefined;
  const index = evidence.findIndex((part: unknown) => {
    if ('object' !== typeof part || null === part) return false;
    return false === Reflect.get(part, 'pass') && undefined === Reflect.get(part, 'inconclusive');
  });
  return index < 0 ? undefined : index;
}

/** The `assertion` a failed `allOf` part kept in the per-part results, if it kept one. */
function partAssertion(evidence: unknown, failedPart: number): string | undefined {
  const part: unknown = Array.isArray(evidence) ? evidence[failedPart] : undefined;
  if ('object' !== typeof part || null === part) return undefined;
  const assertion: unknown = Reflect.get(part, 'assertion');
  return 'string' === typeof assertion ? assertion : undefined;
}

/**
 * The intent fields a recorded check carries: the agent's words, else the sentence built here. Read
 * from the verdict: its evidence names an `allOf`'s failed part, and its assertion says whether a
 * net claim's call was made at all.
 */
export function checkIntent(
  predicate: Predicate,
  verdict: { readonly evidence?: unknown; readonly assertion?: string | undefined },
  given?: string,
): { intent: string; intentDerived?: true; failedPart?: number } {
  const { evidence, assertion } = verdict;
  const failedPart = failedPartOf(predicate, evidence);
  const part = failedPart === undefined ? {} : { failedPart };
  if (given !== undefined && 0 < given.trim().length) return { intent: given, ...part };
  const asserted = failedPart === undefined ? assertion : partAssertion(evidence, failedPart);
  return {
    intent: failureSentence(predicate, failedPart, asserted),
    intentDerived: true,
    ...part,
  };
}

const lower = (text: string): string => text.charAt(0).toLowerCase() + text.slice(1);

/** What a claim makes true, as a sentence: "A POST request to /api/login is made". */
export function expectSentence(predicate: Predicate): string {
  switch (predicate.kind) {
    case PredicateKind.NET:
      return `${capital(noun(predicate))} is made`;
    case PredicateKind.TEXT:
      return `${capital(noun(predicate))} ${true === predicate.absent ? 'does not appear' : 'appears'}`;
    case PredicateKind.SIGNAL:
      return predicate.name === undefined
        ? 'The app reports a signal'
        : `The app reports "${predicate.name}"`;
    case PredicateKind.ROUTE:
      return predicate.pathname !== undefined
        ? `The page moves to ${predicate.pathname}`
        : predicate.contains !== undefined
          ? `The address holds "${predicate.contains}"`
          : 'The route changes';
    case PredicateKind.ELEMENT: {
      const subject = capital(elementNoun(predicate.query));
      if (true === predicate.absent) return `${subject} does not appear`;
      return predicate.state === undefined
        ? `${subject} appears`
        : `${subject} is ${predicate.state}`;
    }
    case PredicateKind.STATE:
      return `The app's state at ${predicate.path} holds the expected value`;
    case PredicateKind.SETTLED:
      return 'The page goes idle';
    case PredicateKind.NOT:
      return `${capital(noun(predicate.predicate))} does not happen`;
    case PredicateKind.ALL_OF:
      return joined(predicate.predicates, ' and ');
    case PredicateKind.ANY_OF:
      return joined(predicate.predicates, ' or ');
    default:
      return `${capital(noun(predicate))} holds`;
  }
}

function joined(predicates: readonly Predicate[], gap: string): string {
  return predicates
    .map((p, i) => (0 === i ? expectSentence(p) : lower(expectSentence(p))))
    .join(gap);
}

/** How many claims a journey's sentence names before it stops: a name, not a transcript. */
const JOURNEY_CLAIMS = 2;

/**
 * A journey in one sentence, from what its steps expect, in order: "A POST request to /api/login is
 * made, then the page moves to /home". An expect that only waits for the page to go idle says
 * nothing about the journey and is skipped. Undefined when no step claims anything else.
 */
export function journeySentence(expects: readonly Predicate[]): string | undefined {
  const claims = expects.filter((p) => PredicateKind.SETTLED !== p.kind).slice(0, JOURNEY_CLAIMS);
  if (0 === claims.length) return undefined;
  return joined(claims, ', then ');
}
