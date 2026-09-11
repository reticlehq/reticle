# @reticlehq/engine

The rules that decide a verdict.

Give it what happened in a running app — the clicks, the network calls, the state changes, the console — and a statement about what should have followed, and it answers whether that statement held. That is all it does. There is no browser here, no server, no command line and no storage.

## Why it is on its own

Reticle's whole claim is that a verdict means something. The part that makes that claim is small and depends on almost nothing, so it should be possible to take it without taking a daemon you did not ask for. Somebody implementing the [OpenReality](../openreality) specification for a different kind of environment — a phone, a game, a terminal — needs these rules and none of the machinery around them.

## What is inside

- **`events/`** — reading a window of what happened and answering a question about it. Did the request go out? Did the page settle? Did anything contradict anything else?
- **`honesty/`** — the checks on the answer itself. Was the evidence good enough to say yes? Did we watch the same channel we acted on, which would prove nothing? Is "unknown" the honest answer?

## The four answers

A verdict is one of four things, and the last two matter as much as the first two:

| Answer     | What it means                                                                     |
| ---------- | --------------------------------------------------------------------------------- |
| `yes`      | The declared consequence happened, and the evidence is independent of the action. |
| `no`       | It did not happen.                                                                |
| `unknown`  | Nobody could tell. The evidence was missing, stale, or came from the wrong place. |
| `no-fault` | Nothing was declared, so there was nothing to prove.                              |

`unknown` is a real answer, not a rounding error. A tool that turns "I could not see" into "yes" is worse than no tool, because it costs you the one thing you came for.

## What it needs from you

Two things, and both are optional:

- somewhere to **write down** a rule that could not be run at all
- a way to **keep a re-check attached** to the call that asked for it

Leave them out and the rules still work — you lose a log line, never a verdict. You hand them in on the object you pass; the rules never go looking. See `window/engine-host.ts`.
