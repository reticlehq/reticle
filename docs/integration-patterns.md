# Recommended integration patterns

Three small helpers in `@iris/browser` let your app adopt the patterns that real, well-built Iris
integrations converge on — without hand-rolling the boilerplate. All are dev-only and tree-shake
out of production.

- [1 — Inject the emitter (zero prod bundle)](#1--inject-the-emitter-zero-prod-bundle)
- [2 — Pair the mutation with its signal (`commitAndSignal`)](#2--pair-the-mutation-with-its-signal-commitandsignal)
- [3 — Self-registering domains (`registerIrisDomain`)](#3--self-registering-domains-registeririsdomain)
- [How they compose](#how-they-compose)

---

## 1 — Inject the emitter (zero prod bundle)

Your components shouldn't import `@iris/browser` directly — that couples app code to a dev tool.
Instead depend on a tiny structural interface, `IrisEmitter` (`{ signal, state }`), and inject the
real emitter once at the top. `createIrisEmitter()` returns an emitter that proxies to the
connected `iris` singleton, and is a **safe no-op** until `iris.connect()` runs — so nothing breaks
if Iris isn't connected or isn't loaded.

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
`iris.connect()` goes.)

## 2 — Pair the mutation with its signal (`commitAndSignal`)

The common smell: every store mutation hand-emits a signal right after it, and over dozens of call
sites the two **drift** — a new mutation path forgets the emit and the contract silently breaks.
`commitAndSignal` makes the pair one call that can't drift. It runs `mutate()`, emits the signal
exactly once, and returns the mutation's value.

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
propagates** unchanged. This is the lighter alternative to a Zustand middleware: it keeps the
mutation↔signal pairing honest without an audited transition table.

> Genuinely view-level signals — render or async completions like `diff:shown` or
> `caption:generated`, which aren't store state — legitimately stay in your components. Only the
> commit-point signals belong in `commitAndSignal`.

## 3 — Self-registering domains (`registerIrisDomain`)

Rather than maintaining one central flat-map of the whole testable surface (and remembering to wire
each new area into it), co-locate one `iris.ts` per domain that exports its `{ testids, signals,
stores }` and self-registers. The capability registry assembles itself from every domain — later
calls accumulate as a union, with no duplicates.

```ts
// features/cart/iris.ts
import { registerIrisDomain } from '@iris/browser';
registerIrisDomain({
  testids: ['cart-open', 'checkout'],
  signals: ['cart:updated', 'order:saved'],
  stores: ['cart'],
});
```

```ts
// features/search/iris.ts
import { registerIrisDomain } from '@iris/browser';
registerIrisDomain({
  testids: ['search-input'],
  signals: ['search:ran'],
});
```

Importing both modules in dev makes `iris_capabilities()` return the merged surface
(`testids: ['cart-open', 'checkout', 'search-input']`, `signals: ['cart:updated', 'order:saved',
'search:ran']`, `stores: ['cart']`). It composes with `registerCapabilities` /
[`iris.describe`](getting-started.md#step-6--make-your-app-agent-legible-optional-high-leverage):
overlapping entries are deduped across both APIs. (Named flows stay an explicit
`registerCapabilities({ flows })` concern — they use last-writer-wins semantics that don't fit
"accumulate from many domains.")

## How they compose

- `createIrisEmitter()` feeds `commitAndSignal` — the emitter is the injected dependency, so in
  production (Iris not connected) the mutation still runs and the signal is a no-op.
- `registerIrisDomain(...)` feeds `iris_capabilities()` — many domains, one assembled surface.
- All three are dev-only and tree-shake out; your components depend only on the `IrisEmitter`
  interface, never on `@iris/browser` itself.
