# Does your implementation behave like one?

This is how an implementation of [the OpenReality specification](../openreality/SPEC.md) finds out whether it actually does what the specification says — and earns a name for what it can do.

It needs no browser, no app of ours, and no code from this repository.

## The idea

An implementation is scored on **behaviours**, not on fixtures. "A write is accepted and what comes back differs from what was sent" means something on a phone, on a server and in a browser. "Click the element with `data-testid=save`" means something in exactly one of those.

Every scenario here is drawn from a failure this project shipped and then fixed. None is hypothetical, and each says where it came from.

## Profiles, not one bar

A single pass mark quietly sorts implementations by architecture, and only the one it was written against scores full marks. So there are three, and an implementation earns the highest it can answer for:

| Profile | Must observe | Who it is for |
| --- | --- | --- |
| `effect` | network, log | The floor. Something watching from outside the app can reach this. |
| `in-realm` | + state, signals | Code running inside the app's own world. |
| `surface` | + what is on screen | Adds addressing things and checking they are there. |

An implementation that cannot address things on screen is not a worse implementation. It is a different one, and it should say so and still be conformant.

## The rules that decide the outcome

Four, and each exists because of a specific way a suite like this goes wrong:

1. **A scenario that could not be planted is never a pass.** It is reported as unplantable, every time. A scenario that quietly stops being plantable and leaves the denominator is how a scoreboard stays perfect while testing less every month. That has happened here before.
2. **The negative control is mandatory.** Almost every scenario asks for something _other_ than a confident yes, so an implementation that answers "I could not tell" to everything satisfies nearly all of them. One scenario is a completely healthy app with a real claim, and it must produce `yes`.
3. **What you registered must match what you said on connect.** The declaration is itself the first assertion. An implementation claiming a channel it cannot observe would be scored on scenarios it should never have been offered.
4. **A profile is a claim about what you can see**, not only about what you answered. Its channels must be declared.

## Registering

One JSON file. No code here.

```jsonc
{
  "name": "my-implementation",
  "version": "0.1.0",
  "platform": "native", // web | webview | native | service
  "channels": ["net", "log", "state", "signal"], // not "ui" — no elements to address
  "commands": ["capabilities", "act", "query"],
  "profile": "in-realm",
}
```

## Planting the behaviour

The honest hard part: this suite cannot inject a defect into an app it does not own.

So the contract inverts. **You supply the subject.** Ship a small app for your platform and answer one extra command, `x-conformance.plant`, with the scenario's id. The suite then drives your implementation against your app and scores what it says.

That is a real cost, and it is the correct one. It is the same cost this project's own web fixture already pays, and it is the only arrangement in which the suite needs no code from us for a platform we have never seen.

If a plant is refused, the scenario is scored **unplantable** — never passed.

## What we score ourselves

Two scenarios ship failing for this project's own implementation, and they stay on the list:

- **`stale-data-in-a-nested-document`** — the one genuine miss on our own scoreboard.
- **`claim-reads-an-undeclared-channel`** — the rule exists, but no implementation declares its channels yet, including ours, so nothing can be scored on it.

A conformance suite whose author passes everything is a suite shaped around its author. Publishing the gaps is the only way anybody can tell the difference.

## What is here, and what is not

The scenarios, the profiles, the scoring rules and the **driver** are all here, and every one of them is checked by tests that need nothing running.

The reference implementation's own binding is `server/src/connection/realm/conformance-client.ts` — three methods over a live session, and a worked example if you would rather read one than a paragraph. Note what it does _not_ do: it never asks Reticle's verdict kernel anything. Every answer comes from the specification's `adjudicate`, because scoring an implementation against its own rules makes every implementation conformant by construction.

What is still yours to supply is the **binding**: `driveAll` takes a client with three methods — `hello()`, `command(name, args)` and `verify(claim)` — and how those reach your implementation is your business, because we have never seen your platform. Wire them to a socket, a pipe, or a function call.

```js
import { driveAll } from '@reticlehq/conformance/drive.mjs';

const report = await driveAll(myClient, {
  name: 'my-implementation',
  version: '0.1.0',
  platform: 'native',
  channels: ['net', 'log', 'state', 'signal'],
  profile: 'in-realm',
});
```

The driver refuses to help you. A plant that is refused, a call that throws and a scenario that runs long are all **absent** — never failed, and never quietly retried until they pass. A suite that helps is a suite whose scores mean nothing.
