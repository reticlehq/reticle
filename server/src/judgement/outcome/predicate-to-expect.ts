import { PredicateKind } from '@reticlehq/core';
/**
 * The assertion the agent MADE, in the shape a saved flow can keep.
 *
 * `reticle_act_and_wait { until }` is how agents assert — nearly every asserting call in a day of telemetry
 * carried an `until`. `compileActStep` recorded only the ACTION, so a flow saved after an asserted
 * drive came back graded `assertion-free`: "performs actions but asserts no observable consequence —
 * it will pass even if the feature is broken." The agent had already said what success meant;
 * Reticle discarded it and then warned the agent that the flow asserts nothing.
 *
 * That is the regression-suite story failing at its last step. "Record once, verify forever" is only
 * worth anything if the recorded flow can go RED, and locally 32 of 39 saved flows cannot.
 *
 * The inverse of `successToPredicate`. Only the kinds FlowExpect can express are carried: `settled`
 * is a wait rather than a claim, and `animation`/`anyOf`/`not` have no representation at all (`route` gained one — see its case below).
 * Inventing one would write an assertion into the file that the agent never made, which is worse
 * than recording none — a flow that asserts something nobody chose is a false green with extra steps.
 */
import type { FlowExpect } from '@reticlehq/core';
import type { Predicate } from '@reticlehq/engine/question/predicate/predicate.js';

/** Merge two partial expectations; later keys win only where the earlier one said nothing. */
/**
 * Two arms into one flat struct, or nothing.
 *
 * `FlowExpect` has one slot per kind, so two arms of the SAME kind collide. This was
 * `{ ...from, ...into }`, a spread where the earlier arm silently won: `allOf[netA, netB]` saved as
 * `netA` and the second claim was gone with nothing said (0.1).
 *
 * That is a false green with a long fuse. The agent wrote two claims, the file holds one, and every
 * later replay reports green for a flow checking less than the person who recorded it believed -
 * and by then the second claim does not exist for anything to notice.
 *
 * This file's header already states the rule being broken: never write an assertion into a flow
 * file that nothing evaluates. Its twin was missing - never write a SMALLER assertion than the one
 * you were handed. `undefined` propagates to a refusal, which costs the step its expectation and
 * says so, instead of costing the flow its meaning in silence.
 */
function merge(into: FlowExpect, from: FlowExpect): FlowExpect | undefined {
  for (const key of Object.keys(from)) {
    if (key in into) return undefined;
  }
  return { ...from, ...into };
}

export function predicateToExpect(predicate: Predicate): FlowExpect | undefined {
  switch (predicate.kind) {
    case PredicateKind.SIGNAL: {
      if (predicate.name === undefined) return undefined;
      const signal: FlowExpect = { signal: predicate.name };
      if (predicate.dataMatches !== undefined) signal.signalData = predicate.dataMatches;
      if (predicate.count !== undefined) signal.signalCount = predicate.count;
      return signal;
    }
    case PredicateKind.ROUTE: {
      // Carried, not invented: the agent said "until the route is X" in so many words. The kinds
      // below this comment's twin in the header — animation, anyOf, not — stay refused because
      // there the file would gain a claim nobody made.
      const route: { pathname?: string; contains?: string } = {};
      if (predicate.pathname !== undefined) route.pathname = predicate.pathname;
      if (predicate.contains !== undefined) route.contains = predicate.contains;
      return 0 === Object.keys(route).length ? undefined : { route };
    }
    case PredicateKind.NET: {
      const net: NonNullable<FlowExpect['net']> = {};
      if (predicate.method !== undefined) net.method = predicate.method;
      if (predicate.urlContains !== undefined) net.urlContains = predicate.urlContains;
      if (predicate.status !== undefined) net.status = predicate.status;
      if (predicate.count !== undefined) net.count = predicate.count;
      return 0 === Object.keys(net).length ? undefined : { net };
    }
    case PredicateKind.CONSOLE: {
      // `contains` has no representation in FlowExpect.console (core keeps `level` and `absent`
      // and nothing else). Copying the rest through anyway would record an assertion the agent
      // never made: {console, level:'warn', contains:'no-op', absent:true} would save "no warn
      // entries at all", a false red on any unrelated warning, and in the presence direction it
      // saves a strictly weaker claim than the one chosen. This file's own rule applies: record
      // nothing rather than something different, so the flow stays assertion-free there instead.
      if (predicate.contains !== undefined) return undefined;
      const console_: NonNullable<FlowExpect['console']> = {};
      if (predicate.level !== undefined) console_.level = predicate.level;
      if (predicate.absent !== undefined) console_.absent = predicate.absent;
      return 0 === Object.keys(console_).length ? undefined : { console: console_ };
    }
    case PredicateKind.ELEMENT: {
      const element: NonNullable<FlowExpect['element']> = {};
      if (predicate.query.testid !== undefined) element.testid = predicate.query.testid;
      if (predicate.query.role !== undefined) element.role = predicate.query.role;
      if (predicate.query.name !== undefined) element.name = predicate.query.name;
      return 0 === Object.keys(element).length ? undefined : { element };
    }
    case PredicateKind.STATE: {
      // `satisfies` has no representation in FlowExpect, and a `state` clause whose ONLY claim is a
      // property would save as a bare path — "this path exists", which is a strictly weaker
      // assertion than the one the agent made and passes on the empty value it was written to
      // catch. Same rule as `console { contains }` above: record nothing rather than something
      // different. `text { satisfies }` needs no case here; text is refused outright.
      if (predicate.satisfies !== undefined) return undefined;
      const state: NonNullable<FlowExpect['state']> = { path: predicate.path };
      if (predicate.store !== undefined) state.store = predicate.store;
      if (predicate.equals !== undefined) state.equals = predicate.equals;
      return { state };
    }
    case PredicateKind.ALL_OF: {
      // `settled` members drop out on their own by returning undefined.
      let combined: FlowExpect | undefined;
      for (const part of predicate.predicates) {
        const expect = predicateToExpect(part);
        if (expect === undefined) continue;
        if (combined === undefined) {
          combined = expect;
          continue;
        }
        const merged = merge(combined, expect);
        // A collision means the flat struct cannot hold both arms. Refuse the whole conversion
        // rather than persist whichever one happened to be written first.
        if (merged === undefined) return undefined;
        combined = merged;
      }
      return combined;
    }
    default:
      // settled | route | animation | anyOf | not — nothing FlowExpect can say honestly.
      return undefined;
  }
}

/**
 * The subset a REPLAY actually enforces.
 *
 * The rule has never changed: never write an assertion into a flow file that nothing evaluates. A
 * flow reporting `grade: "asserted"` while its assertion is read by no one is a false green, in the
 * feature whose entire purpose is preventing them.
 *
 * What changed is the SET. This kept only `element.testid` and `state`, because for a long time
 * those were the only kinds replay checked — and the note here said lifting it "requires replay to
 * evaluate them per step". Replay now does exactly that: `assertStepExpect` compiles every
 * remaining kind through `successToPredicate` and waits on it. The condition was met and the filter
 * was not updated, so the two drifted.
 *
 * That drift had a cost, and it fell on the agent. `reticle_act_and_wait { until }` IS the agent
 * saying what success means, and `net` is overwhelmingly what it says. Every one of those was
 * discarded at capture, so an agent-recorded flow reached disk assertion-free BY CONSTRUCTION and
 * `reticle_verify` then correctly called it `unverifiable` — the record → save → verify path
 * completing all the way to a run that could never be a pass. Found by driving it.
 *
 * The list below is exactly what `successToPredicate` reads, including an element located by
 * role or name. A testid is also asserted directly against the DOM by the step runner. Anything
 * it cannot compile is still dropped.
 */
export function enforcedOnReplay(expect: FlowExpect | undefined): FlowExpect | undefined {
  if (expect === undefined) return undefined;
  const kept: FlowExpect = {};
  // The step runner asserts a testid against the live DOM before the predicate engine. Role and
  // name are not that path: successToPredicate compiles them, and dropping them here made a
  // recorded `until` by button name vanish so the saved flow could not go red.
  const element = expect.element;
  if (
    undefined !== element &&
    (undefined !== element.testid || undefined !== element.role || undefined !== element.name)
  ) {
    kept.element = element;
  }
  // Everything `successToPredicate` can compile. Replay evaluates EVERY kind of expect through it
  // (see assertStepExpect); this list is what that function actually reads.
  if (expect.state !== undefined) kept.state = expect.state;
  if (expect.signal !== undefined) kept.signal = expect.signal;
  if (expect.signalData !== undefined) kept.signalData = expect.signalData;
  if (expect.signalCount !== undefined) kept.signalCount = expect.signalCount;
  if (expect.net !== undefined) kept.net = expect.net;
  if (expect.console !== undefined) kept.console = expect.console;
  // `route` joined the list the day FlowExpect gained the field. This filter and
  // `successToPredicate` are two allowlists for one question — "can replay check this?" — and the
  // note above records them drifting once already. They drifted again here, in the same direction,
  // within an hour: the field was added, the mapping was added, and a route assertion still reached
  // disk as nothing because THIS list had not heard of it. Found by driving, not by a test.
  if (expect.route !== undefined) kept.route = expect.route;
  return 0 === Object.keys(kept).length ? undefined : kept;
}
