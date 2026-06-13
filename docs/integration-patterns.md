# Iris Integration Patterns

The basics in [Getting Started](getting-started.md) work with **zero app changes**. This doc is the
_recommended_ shape for a real codebase: a minimal production footprint, a signal layer that can't
silently drift, and an adoption path that starts paying off on day one — no rewrite required.

- [1 — Start here: reuse what you already have](#1--start-here-reuse-what-you-already-have)
- [2 — Inject the emitter (zero prod bundle)](#2--inject-the-emitter-zero-prod-bundle)
- [3 — Emit signals from the store layer, not N call sites](#3--emit-signals-from-the-store-layer-not-n-call-sites)
- [4 — Self-registering domains (`registerIrisDomain`)](#4--self-registering-domains-registeririsdomain)
- [5 — Keep the signal layer from rotting (`@iris/eslint-plugin`)](#5--keep-the-signal-layer-from-rotting-iriseslint-plugin)
- [6 — Limitation: un-scriptable tabs → `iris drive`](#6--limitation-un-scriptable-tabs--iris-drive)
- [Checklist](#checklist)

---

## 1 — Start here: reuse what you already have

Adoption is **free → cheap → targeted**. You don't instrument everything; you reuse what you have,
then add the handful of facts the DOM can't express.

**1. Reuse your existing `data-testid` (free).** If you already test with Playwright or Cypress,
your testids work in Iris unchanged — `iris_query({ by: 'testid', value: 'checkout' })` matches them
exactly. No new markup, no new code.

**2. Advertise the surface from your existing constants (cheap).** You already keep a `TestIds`
constant object for your E2E suite — pass it straight in. Now `iris_capabilities()` tells a fresh
agent your whole surface without reading source.

```ts
import { registerCapabilities } from '@iris/browser';
import { TestIds } from '../e2e/test-ids'; // the same constants your Playwright suite uses

registerCapabilities({
  testids: Object.values(TestIds),
  signals: ['order:saved'],
  stores: ['cart'],
});
```

**3. Add signals only at the ~20 commit points that matter (targeted).** Emit `iris.signal(name,
data)` at the moments the DOM can't show — a save committed, a webhook arrived, an edit applied, an
async generation finished. You instrument the off-DOM facts you'd otherwise eyeball, not every line.

```ts
import { iris } from '@iris/browser';
onSaved(() => iris.signal('order:saved', { id, total }));
// agent: iris_assert({ predicate: { kind: 'signal', name: 'order:saved', dataMatches: { id: '*' } } })
```

That's day-one usefulness with no rewrite. The rest of this doc is how to do steps 2–3 _well_ so the
signal layer stays honest as the app grows.

## 2 — Inject the emitter (zero prod bundle)

The #1 objection: _"I don't want a test tool in my production bundle."_ The answer: components never
import `@iris/browser`. They depend on a tiny structural interface, `IrisEmitter` (`{ signal, state
}`), and the real emitter is injected once at the top. `createIrisEmitter()` returns an emitter that
proxies to the connected `iris` singleton and is a **safe no-op** until `iris.connect()` runs — so
nothing breaks in production or before connect, and **`@iris/browser` stays out of the prod bundle.**

```ts
// app/emit.ts — the one place that touches @iris/browser
import { createIrisEmitter } from '@iris/browser';
export const emit = createIrisEmitter(); // no-op until iris.connect()
```

```ts
// any component — depends on the interface, not the SDK
import { emit } from '../emit';
function onSaved(id: string, total: number) {
  emit.signal('order:saved', { id, total });
}
```

The emitter re-checks the connection on every call, so you can create it at module load — before
`iris.connect()` — and it starts forwarding the moment Iris connects. (See
[getting-started Step 2](getting-started.md#step-2--embed-the-sdk-in-your-app) for where
`iris.connect()` goes.) This is the single highest-leverage decision; everything below assumes it.

## 3 — Emit signals from the store layer, not N call sites

The smell: every store mutation hand-emits a signal right after it, and over dozens of call sites the
two **drift** — a new mutation path forgets the emit and the contract silently breaks. Drive the
signal from where the state actually changes instead.

**Pattern A — store middleware (sketch).** One audited map from action → signal lives next to the
store, so _state changed ⇒ signal fired_ is structural, not a thing each call site remembers.

```ts
// store-with-iris.ts — sketch: one audited transition map, not N call sites
import { emit } from './emit';

const signalFor: Record<string, (next: State) => readonly [string, Record<string, unknown>]> = {
  reorderSections: (s) => ['section:reordered', { order: s.order }],
  addSection: (s) => ['section:added', { count: s.sections.length }],
};

function dispatch(action: keyof typeof signalFor, run: () => State): void {
  const next = run();
  const make = signalFor[action];
  if (make !== undefined) emit.signal(...make(next));
}
```

**Pattern B — `commitAndSignal` (lighter).** When you don't want a middleware, pair the mutation and
its signal in one call that can't drift. It runs `mutate()`, emits the signal exactly once, and
returns the mutation's value.

```ts
import { commitAndSignal } from '@iris/browser';
import { emit } from '../emit';

const next = commitAndSignal(
  emit,
  () => store.reorderSections(fromId, toId),
  'section:reordered',
  deriveOrder(store.getState()),
);
```

If `mutate` throws, the mutation never happened — so **the signal is not emitted and the error
propagates** unchanged.

> **The documented exception:** genuinely view-level signals — render or async completions like
> `diff:shown` or `caption:generated`, which aren't store state — legitimately stay in your
> components. Only commit-point signals belong in the store layer.

Pair this with store registration so the agent can _read_ state instead of you emitting a signal per
fact: `registerStore('workspace', () => useWorkspace.getState())`, then `iris_state({ store:
'workspace' })`.

## 4 — Self-registering domains (`registerIrisDomain`)

Rather than maintaining one central flat-map of the whole testable surface (and remembering to wire
each new area into it), co-locate one `iris.ts` per domain that exports its `{ testids, signals,
stores }` and self-registers. The capability registry assembles itself from every domain — later
calls accumulate as a union, with no duplicates.

```ts
// features/sections/iris.ts — co-locate a domain's testids + signals in one module
import { registerIrisDomain } from '@iris/browser';

export const SectionTestIds = { list: 'section-list', add: 'section-add' } as const;
export const SectionSignals = { reordered: 'section:reordered' } as const;

registerIrisDomain({
  testids: Object.values(SectionTestIds),
  signals: Object.values(SectionSignals),
  stores: ['workspace'],
});
```

```ts
// features/search/iris.ts
import { registerIrisDomain } from '@iris/browser';
registerIrisDomain({ testids: ['search-input'], signals: ['search:ran'] });
```

Importing both modules in dev makes `iris_capabilities()` return the merged surface
(`testids: ['section-list', 'section-add', 'search-input']`, `signals: ['section:reordered',
'search:ran']`, `stores: ['workspace']`). `registerIrisDomain` is a thin convenience over
`registerCapabilities` — same merge-idempotent, HMR-safe semantics — so it composes with §1's "use
your existing constants." (Named flows stay an explicit `registerCapabilities({ flows })` concern —
their last-writer-wins semantics don't fit "accumulate from many domains.")

## 5 — Keep the signal layer from rotting (`@iris/eslint-plugin`)

A signal layer silently rots: someone adds a mutation path and forgets the signal, and the agent's
contract breaks with no error. The lint rule catches it at the only moment that's cheap — review.

The rule **`iris/require-signal-on-mutation`** flags a function that calls a configured store mutator
but emits no signal in the same function. It is a **safe no-op until you tell it which calls mutate
state** (`mutators`) and which call emits a signal (`signalCallee`, default `signal` / `irisSignal`):

```js
// eslint.config.js (flat config)
import iris from '@iris/eslint-plugin';

export default [
  {
    plugins: { iris },
    rules: {
      'iris/require-signal-on-mutation': [
        'warn',
        { mutators: ['set', 'reorderSections', 'addSection'], signalCallee: 'signal' },
      ],
    },
  },
];
```

Or turn it on with the shipped preset (warns, with empty no-op defaults you then configure):
`plugin.configs.recommended`. A function that calls a mutator and a signal together passes; a mutator
with no signal reports `store mutation without a mapped Iris signal`. The documented view-level
exceptions from §3 simply don't list those view callees as `mutators`, so they never fire.

## 6 — Limitation: un-scriptable tabs → `iris drive`

Iris observes and drives a tab through the in-page SDK plus (optionally) CDP. It **cannot bring to
front or recover a browser tab the OS won't let it script** — e.g. a backgrounded tab, or a
non-default browser (Dia, etc.) reporting `hidden:true` / `throttled:true`.

When that happens, `iris_sessions` and every act/assert result carry a `session.recommendation`
saying so. The escape hatch is **`iris drive <url>`** (add `--headed` to watch) — Iris launches and
owns a guaranteed-scriptable browser. See
[usage §18](usage.md#18-real-input-mode--native-hover--drag-m58) for the full note.

## Checklist

- [ ] One `app/emit.ts` is the **only** module importing `@iris/browser`; components import the emitter.
- [ ] `iris.connect()` is dev-gated; the prod bundle has no `@iris/browser`.
- [ ] Signals fire from the store layer (middleware or `commitAndSignal`); view-level exceptions are explicit.
- [ ] Each domain self-registers via `registerIrisDomain`; `iris_capabilities()` returns the full surface.
- [ ] Existing Playwright/Cypress testids are reused, not duplicated.
- [ ] `iris/require-signal-on-mutation` is enabled with your `mutators` + `signalCallee`.
- [ ] The team knows `iris drive <url>` for un-scriptable tabs.
