---
title: Writing an adapter
description: What an adapter is, which kinds exist, and how to build one of your own.
---

Reticle watches an app from the inside. Most of what it does is the same everywhere: a click is a click, a failed request is a failed request. A few things are not, and those are what adapters are for.

There are three kinds, and they answer three different questions.

| kind | the question it answers | example |
| --- | --- | --- |
| **framework** | given an element on the page, which component is it and which file is that written in? | `@reticlehq/react` |
| **build** | how does the SDK get into the page, and how does an element learn which file it came from? | `@reticlehq/vite-plugin` |
| **realm** | how do we watch this kind of app's own traffic and take its picture? | `@reticlehq/electron` |

You almost certainly want the first one. It is the only kind you can write today without changing Reticle itself, and it is the one that makes a failing check say `src/CartRow.tsx:42` instead of "something on the page".

## Writing a framework adapter

An adapter is an object with a name and one required function. Register it once, when your module loads.

```ts
import { registerAdapter } from '@reticlehq/browser';

registerAdapter({
  name: 'solid',
  identify(element) {
    const owner = findSolidOwner(element); // your framework's own lookup
    if (owner === null) return null; // not ours: let another adapter answer
    return {
      componentStack: ['CartRow', 'Cart', 'App'], // innermost first
      source: { file: 'src/CartRow.tsx', line: 42 },
    };
  },
});
```

That is the whole required surface. Two optional functions add more:

```ts
registerAdapter({
  name: 'solid',
  identify,
  readState: (element) => currentSignalsFor(element), // what the component is holding
  hasHoverHandlers: (element) => hasOnEnter(element), // hover may need a real mouse
});
```

### The rules, and why each exists

**Return `null` when the element is not yours.** Adapters are asked in turn and the first real answer wins, so `null` means "ask the next one" rather than "there is no answer". An adapter that returns a guess for everything makes every other adapter unreachable.

**`componentStack` runs innermost first.** The element's own component, then its parent, and so on. It is used to name what was clicked, and the closest name is the useful one.

**`source.file` should be relative to the project root** if you can manage it. An absolute path from the machine that built the bundle means nothing on the machine reading the verdict, and Reticle cannot tell one from the other.

**Nothing you return is trusted as a verdict.** An adapter says what an element _is_. Whether a check passed is decided elsewhere, from what the page actually did, and there is no field you can set that changes it. This is deliberate: a verdict that could be supplied by the thing being verified is not a verdict.

**Throwing is contained but not free.** A throw is caught rather than allowed to take the page down. It is still a bad outcome, because the element goes unidentified and every verdict about it loses its source pointer. Return `null` when you do not know, rather than raising.

### Registering more than once

Registration is idempotent by name: registering `solid` twice leaves one. The registry also survives a hot reload, because a module re-evaluated by the dev server would otherwise drop its adapter and source mapping would quietly degrade until the next full refresh.

## The other two kinds

Honest about where things stand: **build and realm adapters are not yet something you can add from outside.** Both exist, both work, and both are wired in by name rather than registered.

A **build adapter** is a plugin for your build tool. It does two things: make sure `connect()` runs in the page, and stamp each element with the file it came from. `@reticlehq/vite-plugin` is the one to read. Adding another today means a change to Reticle's own installer, because the installer has to know which projects need which plugin.

A **realm adapter** teaches Reticle about a kind of app that is not a browser tab: an Electron window, a Tauri window. It supplies the shell's own message traffic and a way to photograph the window. `@reticlehq/electron` is the one to read. What a realm _is_ now lives in one table (`core/src/realm/registry.ts`), so the facts are in one place; what a realm _does_ is still code inside Reticle.

If you want to write either, open an issue and say what you are building. The interfaces exist; what is missing is the door.

A template for each of the four kinds, including the two that are contributable today, is in [`adapters/CONTRIBUTING.md`](../adapters/CONTRIBUTING.md). It carries the rules each adapter kind must hold to, and why each rule exists.
