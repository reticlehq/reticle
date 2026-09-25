/**
 * Reading a predicate's TOP-LEVEL clauses.
 *
 * Structural, not evaluative: these answer "what does this predicate say" from the shape alone, the
 * same basis `predicateShapeFor` sits here on. Nothing here decides anything about an app.
 *
 * It lived beside the replay code until the journal's flow-naming needed it too, and a
 * `journal -> flows` reach is a file filed in the wrong place rather than a dependency anybody
 * wanted. The thing both callers want is a reader for a core type, so it lives with the type.
 *
 * v1 stored one slot per kind, so "does this step assert state?" was a property read and "drop the
 * element clause" was a `delete`. A `Predicate` nests, so every one of those questions is a walk.
 *
 * The walks here are deliberately SHALLOW, and that is the whole design. A lifted v1 file produces
 * either a single leaf or one flat `allOf`, so a top-level walk reproduces v1 behaviour exactly. A
 * hand-written v2 predicate can nest arbitrarily, and going deeper would silently change what an
 * existing flow asserts:
 *
 * - dropping a leaf from an `allOf` removes a conjunct, which is what v1's `delete` did;
 * - dropping a branch from an `anyOf` removes an ALTERNATIVE, which makes the predicate STRICTER
 *   and can turn a passing flow red;
 * - dropping anything under a `not` inverts the meaning of the thing you dropped.
 *
 * So the composite cases are handled where they mean what v1 meant, and left alone everywhere else.
 */
import { PredicateKind } from './consequence.js';
import type { Predicate } from './predicate.js';

/** Every clause at the top level: the predicate itself, or the members of a top-level `allOf`. */
export function conjuncts(predicate: Predicate | undefined): readonly Predicate[] {
  if (predicate === undefined) return [];
  return PredicateKind.ALL_OF === predicate.kind ? predicate.predicates : [predicate];
}

/** The first top-level clause of this kind, or undefined. */
export function clauseOfKind<K extends Predicate['kind']>(
  predicate: Predicate | undefined,
  kind: K,
): Extract<Predicate, { kind: K }> | undefined {
  return conjuncts(predicate).find(
    (one): one is Extract<Predicate, { kind: K }> => one.kind === kind,
  );
}

/** Does this expectation assert store state at the top level? The drift kind branches on it. */
export function assertsState(predicate: Predicate | undefined): boolean {
  return clauseOfKind(predicate, PredicateKind.STATE) !== undefined;
}

/** The testid an element clause names, when the expectation has one at the top level. */
export function expectedElementTestid(predicate: Predicate | undefined): string | undefined {
  const element = clauseOfKind(predicate, PredicateKind.ELEMENT);
  return element?.query.testid;
}

/**
 * Rebuild the expectation without the top-level clauses a caller wants gone, collapsing as it goes.
 *
 * One clause left is that clause, not an `allOf` of one: a single-member composite grades weaker
 * than its own member and reads worse in a report, and `combine()` has had to be taught about
 * zero-branch composites once already.
 */
export function withoutClauses(
  predicate: Predicate | undefined,
  drop: (clause: Predicate) => boolean,
): Predicate | undefined {
  if (predicate === undefined) return undefined;
  const kept = conjuncts(predicate).filter((clause) => !drop(clause));
  const [only] = kept;
  if (0 === kept.length) return undefined;
  if (1 === kept.length && only !== undefined) return only;
  return { kind: PredicateKind.ALL_OF, predicates: [...kept] };
}

/**
 * Name what was asserted, for the drift row's `anchor` column.
 *
 * Reports the STRONGEST clause rather than the first, because that is the one a reader is asking
 * about: an `allOf[settled, net]` is about the request, and answering "settled" names the gate
 * instead of the claim.
 */
export function expectLabel(predicate: Predicate | undefined): string {
  const clauses = conjuncts(predicate);
  const signal = clauses.find((c) => PredicateKind.SIGNAL === c.kind);
  if (signal !== undefined && PredicateKind.SIGNAL === signal.kind) {
    return `signal:${signal.name ?? '*'}`;
  }
  const net = clauses.find((c) => PredicateKind.NET === c.kind);
  if (net !== undefined && PredicateKind.NET === net.kind) {
    return `net:${net.urlContains ?? net.method ?? '*'}`;
  }
  const state = clauses.find((c) => PredicateKind.STATE === c.kind);
  if (state !== undefined && PredicateKind.STATE === state.kind) return `state:${state.path}`;
  const console_ = clauses.find((c) => PredicateKind.CONSOLE === c.kind);
  if (console_ !== undefined && PredicateKind.CONSOLE === console_.kind) {
    return `console:${console_.level ?? '*'}`;
  }
  const element = clauses.find((c) => PredicateKind.ELEMENT === c.kind);
  if (element !== undefined && PredicateKind.ELEMENT === element.kind) {
    const q = element.query;
    return q.testid ?? q.name ?? q.role ?? 'element';
  }
  const text = clauses.find((c) => PredicateKind.TEXT === c.kind);
  if (text !== undefined && PredicateKind.TEXT === text.kind) return `text:${text.contains ?? '*'}`;
  const route = clauses.find((c) => PredicateKind.ROUTE === c.kind);
  if (route !== undefined && PredicateKind.ROUTE === route.kind) {
    return `route:${route.pathname ?? route.contains ?? '*'}`;
  }
  return 'expect';
}

/**
 * An element ref: `e` and a sequence number, minted per session by the SDK's ref table. It is an
 * address inside ONE session's numbering, not an identity.
 */
export const SESSION_REF = /^e\d+$/;

/** Why a flow refused a predicate holding a ref, naming the field. */
export function sessionRefRefusal(field: string): string {
  return (
    `${field} is an element ref, which only exists in the session that minted it — ` +
    'scope by a CSS selector or a testid so the flow can check it again'
  );
}

/**
 * The first field anywhere in the tree that holds a session ref, as `kind.field "value"`.
 *
 * DEEP, unlike every reader above: those walk the top level because dropping a nested clause would
 * change what a flow means, while this only asks whether the predicate can mean anything at all in
 * another session. A ref under a `not` is exactly as meaningless as one at the top.
 */
export function sessionBoundField(predicate: Predicate): string | undefined {
  const ref = (field: string, value: string | undefined): string | undefined =>
    value !== undefined && SESSION_REF.test(value) ? `${field} "${value}"` : undefined;
  switch (predicate.kind) {
    case PredicateKind.ALL_OF:
    case PredicateKind.ANY_OF:
      for (const one of predicate.predicates) {
        const found = sessionBoundField(one);
        if (found !== undefined) return found;
      }
      return undefined;
    case PredicateKind.NOT:
      return sessionBoundField(predicate.predicate);
    case PredicateKind.TEXT:
      return ref('text.scope', predicate.scope);
    case PredicateKind.ELEMENT:
      return ref('element.query.scope', predicate.query.scope);
    case PredicateKind.ANIMATION:
      return ref('animation.target', predicate.target);
    default:
      return undefined;
  }
}
