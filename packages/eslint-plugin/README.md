# @syrin/eslint-plugin

Keeps the Iris **signal layer self-enforcing**. When your store mutates user-visible state,
an `iris.signal(...)` should fire so an agent can assert on the change off-DOM. This plugin
makes "state changed ⇒ signal fired" a lint rule instead of a convention that rots. It pairs
with the runtime `commitAndSignal(mutate, signal, data)` helper from `@syrin/browser`.

## Install

```sh
pnpm add -D @syrin/eslint-plugin
```

Peer dependency: `eslint >= 9` (flat config).

## Flat-config setup

```js
// eslint.config.mjs
import iris from '@syrin/eslint-plugin';

export default [
  {
    plugins: { iris },
    rules: {
      'iris/require-signal-on-mutation': [
        'error',
        {
          mutators: ['set', 'reorderSections', 'addSection'],
          signalCallee: 'irisSignal',
        },
      ],
    },
  },
];
```

Shortcut: enable the bundled `recommended` config (turns the rule on at `warn` with no-op
defaults until you configure `mutators`):

```js
import iris from '@syrin/eslint-plugin';

export default [iris.configs.recommended];
```

## Rule: `require-signal-on-mutation`

Flags a function (declaration, expression, or arrow) that calls a configured **mutator** but
never calls the configured **signal callee** anywhere in that **same** function body.

Report message: `store mutation without a mapped Iris signal`.

### Options

`options[0]`:

| Option         | Type                 | Default                    | Meaning                                             |
| -------------- | -------------------- | -------------------------- | --------------------------------------------------- |
| `mutators`     | `string[]`           | `[]`                       | Callee names that mutate user-visible state.        |
| `signalCallee` | `string \| string[]` | `['irisSignal', 'signal']` | Callee name(s) that count as firing an Iris signal. |

With no options, `mutators` is empty, so the rule is a safe **no-op** (it never fires and
never crashes). Configure `mutators` to switch it on.

### Scoping — per function

Signal-credit is **per function**. A signal called in an enclosing or inner function does
**not** satisfy a mutator called in a different function. Pair the mutation and the signal in
the same body (which is exactly what `commitAndSignal(mutate, signal, data)` does). This is
deliberate: a signal fired in some other scope is not guaranteed to run for the mutation path
that drifted.

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
  irisSignal('sections:reordered');
}

// ❌ invalid — mutation with no mapped signal
function commit() {
  store.set(next); // store mutation without a mapped Iris signal
}
```

## How it fits the workflow

The runtime side advertises signals via `registerCapabilities({ signals: [...] })` (G5) and
fires them with `iris.signal(name, data)`. P5b centralizes that in a Zustand `signalMap` /
`commitAndSignal` pair. This lint rule is the **static** counterpart that guards those pairs
so the signal map can't silently fall behind the store.
