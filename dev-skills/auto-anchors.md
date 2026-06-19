# Auto-anchors — addressing any element with zero hand-added testids

> Goal: integrate with **every** element / component / UI library automatically. Today a stable
> anchor needs a hand-added `data-testid`; without one a step degrades to role/text. Auto-anchors
> derive a durable anchor from what the framework already knows (component + source + role + name),
> so every element is stably addressable with no author effort.

## Why we can do this (the in-source advantage)

Iris's SDK runs **inside** the app, so the React adapter (`@syrin/iris-react`) already maps a DOM
node → fiber → component display name → **source file:line** (`identify()`), plus role/accessible
name from the a11y layer. Playwright, driving from outside, sees only `<button>`; we see
`NewDeployButton @ Deployments.tsx:107`. That component identity + source location is a far more
durable anchor than a CSS/text selector.

## The brain (DONE, pure + tested)

`packages/browser/src/dom/auto-anchor.ts` — `synthesizeAnchor(input): SynthesizedAnchor`. Pure,
framework-agnostic. Picks the most durable anchor by tier:

1. `testid` — explicit. **stable**
2. `component@file:line` — component + source basename. **stable**
3. `component[name|role]` — component + accessible name/role when no source. **stable**
4. `role:name` — semantic but content-dependent. _not stable_
5. `role#nth` / `el#nth` — last resort. _not stable_

Tiers 1–3 are trusted to re-resolve; 4–5 are best-effort (a flow built on them stays "degraded").
Covered by `auto-anchor.test.ts`.

## The wiring (NEXT — supervised, higher blast radius)

This touches the element-resolution path that everything depends on, so it is a supervised,
test-each-step change, not an overnight autonomous one. Plan:

1. **Protocol** — add `QueryBy.COMPONENT` + `ElementQuery.component`/`.source`; add
   `AnchorKind.COMPONENT` (`{ kind:'component', component, source?, role?, name? }`). Exhaustive
   switches to update: `flow-replay.ts` `anchorLabel`, recorder anchor compile, heal/nearest.
2. **Resolve `by:'component'`** — additive `case` in `packages/browser/src/dom/query.ts`
   `findCandidates`: enumerate candidate elements (by role, or `*`), run the registered adapter's
   `identify()` on each, keep those whose nearest component (+ source if given) matches. Existing
   testid/role/text cases are untouched.
3. **Enrich `describe()`** — add an optional, terse `anchor` field (from `synthesizeAnchor`) to the
   ElementDescriptor so snapshots/queries surface a stable anchor per element. Guard token cost:
   only emit when there is no testid (testid already IS the anchor), keep it one short string.
4. **Recorder** — when no testid resolves, compile the step to the synthesized stable anchor
   (tiers 1–3) instead of marking it `degraded`. Degraded stays only for tiers 4–5.
5. **Replay** — `resolveTestid`'s sibling: `resolveComponent` re-finds via `by:'component'`. Drift
   semantics + nearest unchanged.

## Beyond React (the universal part)

`synthesizeAnchor` takes a plain `AnchorInput`, so any adapter that can fill it in plugs in: a Vue
adapter (`__vueParentComponent`), Svelte (component registry), Solid, Angular. One
`FrameworkAdapter` contract (`identify` already exists) → the core stays framework-agnostic. UI
libraries (Radix/MUI/shadcn) get first-class identity for free because their component display
names are exactly what the fiber reports — a later semantics registry can map "this is a Dialog →
its open consequence is …" off that identity.
