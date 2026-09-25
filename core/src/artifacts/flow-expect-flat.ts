/**
 * Reading the FLAT expect a flow file used to store.
 *
 * The older format held one slot per kind — `{ signal, net, element, text, state, console, route }`
 * — which could not nest, compose or negate. A step's expect is a `Predicate` now. This is the
 * reader that bridges them, and it lives in core because the schema that parses a flow is here and
 * the lift happens during the parse.
 *
 * A READ NEVER REWRITES. A v1 file stays v1 on disk until something saves it again; only the value
 * in memory is lifted. That is what makes the migration safe to ship to people whose flows are
 * committed to a repository they share.
 */
import { z } from 'zod';
import { PredicateKind } from '@/verdict/consequence.js';
import type { Predicate } from '@/verdict/predicate.js';

/**
 * A post-condition a step asserts (compiled from a structured annotation; optional).
 *
 * Strict, at every nesting level: an unrecognized key (a typo, or a predicate kind this schema
 * doesn't model, e.g. `allOf`, or a typo'd `net`/`console`/`element`/`state` sub-field) must fail
 * to parse instead of being silently dropped. A loose z.object() here would quietly discard the
 * extra key and leave the step with a weaker (or empty) assertion than its author wrote — the
 * flow then replays green against nothing, having proved no real regression.
 */
export const FlowExpectSchema = z
  .object({
    /**
     * The route the step must have reached — the consequence of a NAVIGATION.
     *
     * Absent until now, and its absence was not a corner case: navigation is one of the commonest
     * journeys there is, and every route-asserted drive saved a flow that could never go red. Found
     * by driving a real app, where `act_and_wait { until: { kind: "route" } }` returned
     * `verified: "yes"` and the flow saved from that same drive graded `assertion-free`.
     *
     * Additive and optional, so a flow file written before it still parses and FLOW_FILE_VERSION
     * stays 1 — the same treatment `signalData` and `signalCount` had.
     */
    route: z
      .object({ pathname: z.string().optional(), contains: z.string().optional() })
      .optional(),
    signal: z.string().optional(),
    /**
     * Optional payload shape an `assert-signal` annotation requires the signal
     * to match (the predicate DSL's signal.dataMatches). Additive/optional — a flow file with a
     * bare `signal` still parses, and the on-disk version stays FLOW_FILE_VERSION 1.
     */
    signalData: z.record(z.unknown()).optional(),
    /**
     * Exact number of times the signal must have fired — the signal-side twin of `net.count`, and the
     * only way a saved flow can keep a cardinality the agent actually asserted. Without it a
     * `count: 1` drive would be recorded as bare presence, which is a strictly WEAKER claim than the
     * one made: the replayed flow then goes green on the double-fire it was recorded to catch.
     * Additive/optional — a flow file with a bare `signal` still parses, and FLOW_FILE_VERSION stays 1.
     */
    signalCount: z.number().int().nonnegative().optional(),
    net: z
      .object({
        method: z.string().optional(),
        urlContains: z.string().optional(),
        status: z.number().optional(),
        /**
         * Exact number of matching requests since the action — turns presence into a cardinality
         * assertion. Catches the double-submit / useEffect-double-fire / retry-storm regression class:
         * the request fired (presence passes) but fired the WRONG number of times. Omit = presence (≥1).
         */
        count: z.number().int().nonnegative().optional(),
      })
      .strict()
      .optional(),
    /**
     * Console golden end-condition: assert the action logged (or, with absent:true, did NOT log) a
     * console message at `level` (default 'error'). `absent:true` is the common case — "the action
     * completed with a clean console" — catching the regression where an action throws a caught error
     * / logs an uncaught rejection while the UI still renders fine (a presence check passes it).
     */
    console: z
      .object({
        level: z.string().optional(),
        absent: z.boolean().optional(),
      })
      .strict()
      .optional(),
    element: z
      .object({
        testid: z.string().optional(),
        role: z.string().optional(),
        name: z.string().optional(),
      })
      .strict()
      .optional(),
    /**
     * Rendered text as an end-condition, using the shapes the assert surface already accepts.
     *
     * The gap this closes: an app with no testids, no `reticle.signal`, no registrable store and no
     * network call on the interaction under test -- a discount price computed and rendered, a
     * formatted total, a derived label -- could not produce an asserted flow AT ALL. Everything the
     * vocabulary offered needed a channel that app does not have, so the only honest outcome was
     * `assertion-free`, which is a permanent green (#811).
     *
     * Derived-DOM rendering is a large share of what actually breaks in a UI, and it was the share
     * that could not be pinned.
     *
     * Classified PRESENCE, not consequence, and that is not a technicality: text is read from the
     * DOM, so a locator healed to the wrong element can still satisfy it. It earns `presence-only`,
     * which is a real grade above `assertion-free` and honestly below `signal`/`net`/`state`.
     */
    text: z
      .object({
        contains: z.string().min(1),
        /** Narrow the search to a container, exactly as the `text` predicate's `scope` does. */
        scope: z.string().optional(),
        /** Assert the text is GONE — the regression check for a cleared error or a dismissed toast. */
        absent: z.boolean().optional(),
        /** Require the match to be visible, not merely present in the DOM. */
        visible: z.boolean().optional(),
      })
      .strict()
      .optional(),
    /**
     * Assert a registered store's value — the source of truth no DOM/network read can reach. Compiles
     * to the predicate engine's `state` predicate. Additive/optional — a flow without it still parses
     * and the on-disk version stays FLOW_FILE_VERSION 1. `equals` accepts a literal, omitted = presence,
     * or a `{ $gte | $contains | $length }` operator pattern.
     */
    state: z
      .object({
        store: z.string().optional(),
        path: z.string(),
        equals: z.unknown().optional(),
        /**
         * Treat this as an INVARIANT that must still hold AFTER the action settles, rather than a
         * condition to wait for. Set it for a blast-radius check ("this unrelated path must NOT have
         * moved") — without it a wait-until-true read passes before an over-reaching side-effect lands.
         */
        hold: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type FlowExpect = z.infer<typeof FlowExpectSchema>;

/**
 * Lift a flat `FlowExpect` into the predicate a current file stores directly.
 *
 * THE READER FOR THE OLDER FORMAT. A flow written before `FlowStep.expect` became a `Predicate` holds one slot
 * per kind, and this is what turns that into the tree everything downstream now evaluates. It runs
 * on READ and changes nothing on disk: a v1 file stays a v1 file until something re-saves it.
 *
 * Faithful on purpose, including one wart it does NOT fix: a `route` clause returns immediately and
 * drops every other clause beside it. That is what v1 files have always meant, and a migration that
 * quietly started asserting a clause those files used to ignore would turn greens red for a reason
 * nobody could see in their diff. It is a real lossy path and it is being fixed separately, where it
 * can carry its own test and its own explanation.
 *
 * `undefined` means nothing assertable, which is vacuously met rather than failed.
 */
export function flowExpectToPredicate(success: FlowExpect): Predicate | undefined {
  const parts: Predicate[] = [];

  if (success.signal !== undefined) {
    const signal: Extract<Predicate, { kind: typeof PredicateKind.SIGNAL }> = {
      kind: PredicateKind.SIGNAL,
      name: success.signal,
    };
    if (success.signalData !== undefined) signal.dataMatches = success.signalData;
    if (success.signalCount !== undefined) {
      signal.count = success.signalCount;
      // Same post-settle reasoning as net.count: the success waiter is wait-until-true, so an exact
      // count is transiently satisfied the instant the FIRST matching signal fires — before a
      // double-fire's duplicate arrives. Gating on `settled` forces the count to be read only after
      // the app goes quiet, by which point the duplicate IS counted and the over-count fails.
      parts.push({ kind: PredicateKind.SETTLED });
    }
    parts.push(signal);
  }

  if (success.route !== undefined) {
    // The mirror of `predicateToExpect`'s ROUTE case. Replay evaluates predicates, so carrying the
    // route back here is the whole of what makes a recorded navigation able to fail.
    const route: { kind: typeof PredicateKind.ROUTE; pathname?: string; contains?: string } = {
      kind: PredicateKind.ROUTE,
    };
    if (success.route.pathname !== undefined) route.pathname = success.route.pathname;
    if (success.route.contains !== undefined) route.contains = success.route.contains;
    return route;
  }
  if (success.net !== undefined) {
    const net: Extract<Predicate, { kind: typeof PredicateKind.NET }> = { kind: PredicateKind.NET };
    if (success.net.method !== undefined) net.method = success.net.method;
    if (success.net.urlContains !== undefined) net.urlContains = success.net.urlContains;
    if (success.net.status !== undefined) net.status = success.net.status;
    if (success.net.count !== undefined) {
      net.count = success.net.count;
      // A cardinality assertion is inherently POST-SETTLE. The success waiter is wait-until-true, so an
      // exact count (e.g. 1) is transiently satisfied the instant the FIRST matching request lands —
      // before a double-submit's duplicate arrives. Gating on `settled` forces the count to be read
      // only after the network has gone quiet, so the duplicate IS counted and the over-count fails.
      parts.push({ kind: PredicateKind.SETTLED });
    }
    parts.push(net);
  }

  if (success.console !== undefined) {
    const con: Extract<Predicate, { kind: typeof PredicateKind.CONSOLE }> = {
      kind: PredicateKind.CONSOLE,
    };
    if (success.console.level !== undefined) con.level = success.console.level;
    if (success.console.absent !== undefined) {
      con.absent = success.console.absent;
      // An `absent` assertion is post-settle, same as net.count: a wait-until-true waiter sees "no
      // error yet" at the first poll and passes BEFORE the action's error fires. Gate on `settled` so
      // the console is read only after the page quiets, by which point any error is in the buffer.
      if (success.console.absent) parts.push({ kind: PredicateKind.SETTLED });
    }
    parts.push(con);
  }

  const state = success.state;
  if (state !== undefined) {
    const part: Extract<Predicate, { kind: typeof PredicateKind.STATE }> = {
      kind: PredicateKind.STATE,
      path: state.path,
    };
    if (state.store !== undefined) part.store = state.store;
    if (state.equals !== undefined) part.equals = state.equals;
    // `hold` = an INVARIANT ("this state must still hold after the action settles"), vs the default
    // wait-for-change. A wait-until-true waiter would pass the instant the path already equals the
    // value — which, for "an unrelated path stayed put", is true BEFORE a side-effect leak fires. Gate
    // on `settled` so the read happens after the page quiets, by which point the leak has landed.
    if (true === state.hold) parts.push({ kind: PredicateKind.SETTLED });
    parts.push(part);
  }

  const element = success.element;
  if (element !== undefined) {
    /*
     * The dynamic (LLM-output) skip is NOT applied here, and that is the whole reason this moved.
     *
     * "Do not assert the presence of a testid whose content a model writes" is a REPLAY rule, not a
     * fact about the file. Applying it during the read would make the lift lossy in a way that
     * depends on a sibling field, and a v1 file would mean two different things depending on who
     * was reading it. The lift is faithful; replay applies its own rule to the predicate.
     */
    const query: Record<string, string> = {};
    if (element.testid !== undefined) query['testid'] = element.testid;
    if (element.role !== undefined) query['role'] = element.role;
    if (element.name !== undefined) query['name'] = element.name;
    if (Object.keys(query).length > 0) parts.push({ kind: PredicateKind.ELEMENT, query });
  }

  const text = success.text;
  if (text !== undefined) {
    const part: Extract<Predicate, { kind: typeof PredicateKind.TEXT }> = {
      kind: PredicateKind.TEXT,
      contains: text.contains,
    };
    if (text.scope !== undefined) part.scope = text.scope;
    if (text.visible !== undefined) part.visible = text.visible;
    if (true === text.absent) {
      part.absent = true;
      // Same post-settle reasoning as `console.absent` and `state.hold`: a wait-until-true waiter
      // reads "not there yet" on the first poll and passes BEFORE the text it is meant to see
      // disappear has even been rendered. Gate on `settled` so the read happens after the page
      // quiets, by which point a text that was going to appear has.
      parts.push({ kind: PredicateKind.SETTLED });
    }
    parts.push(part);
  }

  const [first] = parts;
  if (0 === parts.length) return undefined;
  if (1 === parts.length && first !== undefined) return first;
  return { kind: PredicateKind.ALL_OF, predicates: parts };
}
