# Realms — how an agent interacts with a kind of environment

A **realm** is the layer that lets an agent do things in an environment and see what happened. It answers four questions, and only these four:

| Question | What it means |
| --- | --- |
| **What is here?** | Describe what exists right now, in a form an agent can point at. |
| **Do this.** | Click, type, scroll, navigate — whatever "doing something" means here. |
| **What happened?** | Watch for the consequences: things that changed, requests that went out, errors. |
| **Show me.** | Take a picture, when a picture is the only honest answer. |

Everything else is built on top of that. A **framework adapter** (React, Vue, Svelte) does not talk to the environment at all — it tells the realm how to turn a thing on screen into "the Cart component, defined in `Cart.tsx` line 40". Every web framework uses the same realm, because they all end up as a page. A phone framework would use a phone realm. That is the point of naming the layer: the number of framework adapters times the number of environments would otherwise be the number of integrations somebody has to write.

## What is here

| Realm | Environment |
| --- | --- |
| [`dom/`](dom) | A web page. Published as `@reticlehq/browser`. |
| [`electron/`](electron) | An Electron app's main process, where the window lives and messages cross between halves. |

## The feedback loop belongs to the realm

The realm is not just a way to send commands. It is also the way results come back:

```
agent  ->  asks the realm to do something
           the realm does it in the environment
           the environment reacts: DOM changes, requests, errors, state
           the realm watches all of that and records it
agent  <-  gets back what actually happened, not what was supposed to happen
```

That loop is why a verdict can mean anything. An agent that only sends commands is guessing; an agent that gets the consequences back can be told "no, that did not happen".

You can attach to that loop from your own code. Anything your app emits into the realm arrives with everything else the realm saw, so an assertion can be made about it. See [`docs/adapters.md`](../../docs/adapters.md) for how.

## Writing your own realm

Follow the shape of `dom/`:

1. **Publish the four verbs.** Describe, act, watch, photograph. If your environment cannot do one of them, say so out loud rather than faking it — a realm that pretends to have taken a picture is worse than one that admits it cannot.
2. **Send the same events everyone else sends.** The names and shapes live in `@reticlehq/core`. Nothing downstream should be able to tell which realm an event came from.
3. **Never invent a wire string.** If you need a new one, it goes in `@reticlehq/core` first, so both ends of the connection agree.
4. **Depend on `@reticlehq/core` and as little else as you can.** Whoever adopts your realm adopts your dependencies too.

## One thing that is NOT shared yet, and why

You would expect the registry (how a framework adapter plugs in) and the transport (the connection back to the daemon) to be realm-neutral, and to live somewhere both realms could reach.

They are not, today. Six of the ten files involved are written against a web page specifically: the registry identifies a **DOM element**, and the transport reconnects when a **browser tab** becomes visible again. Five are genuinely neutral.

They stay where they are on purpose. Making them neutral means inventing a general shape with exactly one thing implementing it, and a shape invented before a second case exists is nearly always the wrong shape. The moment a second realm actually needs them, that is the moment to move them — and this paragraph is here so whoever hits it knows the question was asked and what the answer was.
