/**
 * The clock this daemon injects, declared once.
 *
 * Rule 7 says never call `Date.now()` inside pure logic — pass it in. Nothing said WHERE the type
 * that gets passed in lives, so it was declared four times: in `flows.ts`, in `intent-store.ts`, in
 * `intent-shard-store.ts`, and as a differently-shaped `() => number` inside `session.ts`. Three of
 * the four were the same interface spelled twice as `now(): number` and once as `now: () => number`.
 *
 * The cost was not the duplication, it was what the duplication made somebody do: `project-store.ts`
 * needed a clock type, found the nearest declaration in `flows.ts`, and imported it — so `memory/`
 * now depended on `language/`, which already depended on `memory/` ten files over. One type-only
 * import of a two-line interface, reaching across a 975-line module, closed a cycle between two
 * directories that have no business knowing about each other.
 *
 * So it lives here, for the reason `platform.ts` gives next door: Node-side only, ambient, and it
 * never crosses the wire, so it is deliberately NOT in `@reticlehq/core`. `machine/` imports nothing
 * and is therefore the one place in this package that cannot be half of a cycle.
 *
 * `session.ts` keeps its own `() => number`: a bare function and an object with a `now` are
 * different contracts, and merging them would change every call site to prove a point about tidiness.
 */
export interface Clock {
  now(): number;
}
