# Writing an adapter

Four kinds, and they are not equally open. This says which door is actually there, what the minimum adapter looks like for each, and where the edge is — because "extensible" that turns out to mean "open an issue and wait" is worse than a documented limit.

| Kind | Teaches Reticle | Addable from outside today? |
| --- | --- | --- |
| **framework** | how a thing on screen maps to a component and a source file | **yes** — registration is public |
| **lint** | a rule about the user's own source | **yes** — it is an ESLint plugin, nothing to register |
| **build** | how `connect()` reaches the page, and how elements get stamped | not yet — the installer resolves by name |
| **realm** | a kind of environment that is not a browser tab | not yet — wired by name, though what a realm IS lives in one table |

## framework — the one with a public door

A framework adapter never touches the environment. It answers one question: _given this element, which component is it and where is that component defined?_ Every web framework shares one realm, because they all end up as a page — which is the point of separating the layers. Otherwise the number of integrations is frameworks × environments.

```ts
import { registerFrameworkAdapter } from '@reticlehq/browser';

registerFrameworkAdapter({
  name: 'svelte',
  // Return undefined when this is not your framework's element. Never guess: a wrong component name
  // sends somebody to the wrong file, which is more expensive than no name at all.
  componentFor(el: Element) {
    const meta = (el as { __svelte_meta?: { loc?: { file: string; line: number } } }).__svelte_meta;
    if (meta?.loc === undefined) return undefined;
    return { component: 'Component', source: { file: meta.loc.file, line: meta.loc.line } };
  },
});
```

The rules, each of which exists because breaking it produced a real bad verdict:

- **Return `undefined` rather than a guess.** A source pointer is acted on. `file:line` on a failure is measured at 83/85 with a control at 0/22, and that only holds while a pointer means something.
- **Never throw.** An adapter that throws takes the snapshot with it, and the agent loses the page rather than one component name.
- **Be pure and synchronous.** This runs inside a snapshot, per element.

## lint — no registration needed

A lint adapter is an ordinary ESLint plugin. `@reticlehq/eslint-plugin` is the one to read; its rule is "state changed ⇒ a signal fired", which is the instrumentation that makes a consequence oracle possible. Nothing here couples to Reticle's runtime, so there is nothing to register: publish it and tell people to extend their config.

## build — the door is not there yet

A build adapter does two things: make sure `connect()` runs in the page, and stamp each element with the file it came from. `@reticlehq/vite-plugin` is the reference.

What blocks outside contribution is not the interface — it is that `reticle init` must decide which plugin a project needs, and that resolution is by name inside the installer. A registry would have to answer "which build tool is this project using" from outside, and getting that wrong writes a broken config into somebody's repo, which is the failure the install gate exists to catch.

If you are writing one, open an issue naming the build tool. The interface is stable; the resolution is the open design question.

## realm — the door is not there yet either

A realm teaches Reticle about an environment that is not a browser tab. It answers four questions and only these four: _what is here_, _do this_, _what happened_, _show me_. `@reticlehq/electron` is the reference, and `openreality`'s `Realm` is the contract.

Two things are already open, and they are the parts that used to be scattered: what a realm IS lives in one table (`core/src/realm/registry.ts`), and what it may CLAIM is checked by the protocol — `perform()` refuses an undeclared capability before an action is spent, and `typecheckProgram` refuses a whole document before one is dispatched. So a realm cannot quietly overstate itself.

What is still code inside Reticle is the wiring. Open an issue naming the environment.

---

**The honest summary**: two of four kinds are contributable today. The other two have stable interfaces and no registration, and this file says so rather than implying otherwise — an extensibility story that overstates itself costs a contributor an afternoon before they find out.
