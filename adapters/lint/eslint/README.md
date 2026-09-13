# @reticlehq/eslint-plugin

Keeps the Reticle **signal layer self-enforcing**. When your store mutates user-visible state, an `reticle.signal(...)` should fire so an agent can assert on the change off-DOM. This plugin makes "state changed ⇒ signal fired" a lint rule instead of a convention that rots. It pairs with the runtime `commitAndSignal(mutate, signal, data)` helper from `@reticlehq/browser`.

## Install

```bash
npm i -D @reticlehq/eslint-plugin
```

Peer dependency: `eslint >= 9` (flat config).

## Flat-config setup

```js
// eslint.config.mjs
import reticle from '@reticlehq/eslint-plugin';

export default [
  {
    plugins: { reticle },
    rules: {
      'reticle/require-signal-on-mutation': [
        'error',
        {
          mutators: ['set', 'reorderSections', 'addSection'],
          signalCallee: 'reticleSignal',
        },
      ],
    },
  },
];
```

Shortcut: enable the bundled `recommended` config (turns the rule on at `warn` with no-op defaults until you configure `mutators`):

```js
import reticle from '@reticlehq/eslint-plugin';

export default [reticle.configs.recommended];
```

## Rule: `require-signal-on-mutation`

Flags a function (declaration, expression, or arrow) that calls a configured **mutator** but never calls the configured **signal callee** anywhere in that **same** function body.

Report message: `store mutation without a mapped Reticle signal`.

### Options

`options[0]`:

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `mutators` | `string[]` | `[]` | Callee names that mutate user-visible state. |
| `signalCallee` | `string \| string[]` | `['reticleSignal', 'signal']` | Callee name(s) that count as firing an Reticle signal. |

With no options, `mutators` is empty, so the rule is a safe **no-op** (it never fires and never crashes). Configure `mutators` to switch it on.

### Matching is by BARE CALLEE NAME

A mutator is matched on the call's name alone — the object is ignored, so `store.set(...)`, `map.set(...)`, `url.searchParams.set(...)` and `res.headers.set(...)` are all the same call to this rule.

That matters most for the name you are most likely to configure. `set` is zustand's mutator, so it is the natural first entry — and it also matches every `Map`, `Set`, `URLSearchParams` and `Headers` call in the same file, each of which will be reported as an unsignalled mutation. Verified: a function that only builds a lookup `Map` is flagged.

Prefer a name that is unambiguous in your codebase — a wrapper like `commitAndSignal`, or a domain verb (`applyOrder`, `reorderSections`) — over a generic one. A rule that fires on `map.set()` gets turned off wholesale, and then it protects nothing.

### Scoping — per function

Signal-credit is **per function**. A signal called in an enclosing or inner function does **not** satisfy a mutator called in a different function. Pair the mutation and the signal in the same body (which is exactly what `commitAndSignal(mutate, signal, data)` does). This is deliberate: a signal fired in some other scope is not guaranteed to run for the mutation path that drifted.

### Matching — by name

The callee is matched by **name**, ignoring the object:

- `set(...)` — matched.
- `this.set(...)` — matched (`set`).
- `store.set(...)` — matched (`set`).
- `store['set'](...)` — **not** matched (computed member access; documented limitation).

### Examples

```js
// ✅ valid — mutation + signal in the same function
function commit() {
  set(next);
  reticleSignal('sections:reordered');
}

// ❌ invalid — mutation with no mapped signal
function commit() {
  store.set(next); // store mutation without a mapped Reticle signal
}
```

## How it fits the workflow

The runtime side advertises signals via `registerCapabilities({ signals: [...] })` and fires them with `reticle.signal(name, data)`. A Zustand `signalMap` / `commitAndSignal` pair centralizes that in your store. This lint rule is the **static** counterpart that guards those pairs so the signal map can't silently fall behind the store.

Apache-2.0.
