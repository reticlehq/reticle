# Flows, the recorder & self-healing — record once, run forever

Iris turns an interactive run into a **git-checked, replayable program** stored under `.iris/`.
Flows are anchored on **meaning** (testid + signal), not volatile element refs or coordinates,
so they survive refactors — and when an anchor does drift, Iris tells you _why_ and can repair
it. This is what makes Iris "the project's living test suite a human seeds and an agent
maintains."

> All of this is on-disk and human-readable, so flows are reviewed in PRs and diffed like code.

## The `.iris/` directory

When you record or save a contract, Iris writes a git-checked workspace next to your app:

```
.iris/
  contract.json            # the app's testable surface (testids, signals, stores)
  flows/
    create-drop.json       # a recorded, anchored, replayable flow
  baselines/               # snapshot baselines (co-located)
```

The server resolves `.iris/` from the working directory it runs in (your project root). A
fresh agent can read `.iris/contract.json` to learn the testable surface **without grepping
your source**.

## The contract — advertise the testable surface

In your app, declare what's testable (see [Step 6 in Getting Started](getting-started.md)):

```ts
import { registerCapabilities } from '@syrin/iris';
registerCapabilities({
  testids: ['add-task', 'checkout'],
  signals: ['order:saved'],
  stores: ['cart'],
});
```

Then persist it to disk so it's committed and any agent can read it:

| Tool                   | What it does                                                               |
| ---------------------- | -------------------------------------------------------------------------- |
| `iris_capabilities()`  | the live testable surface `{ testids, signals, stores, flows }`            |
| `iris_contract_save()` | write the live capabilities to `.iris/contract.json` (versioned, diffable) |

## Create a flow

**(a) Agent-recorded** — the agent drives, then saves:

```jsonc
iris_record_start({ recordingName: "create-task" })
iris_act({ ref: "e7", action: "click" })        // … drive the golden path …
iris_record_stop({ recordingName: "create-task" })
iris_flow_save({ flowName: "create-task" })          // → .iris/flows/create-task.json
```

**(b) Human-recorded (the recorder toolbar)** — with the presenter on (`present: true`), the
floating panel hosts a recorder: a human clicks the golden path in the page and Iris captures
each interaction as a **semantic-anchored** step (testid, else role+name), then persists it via
`iris_flow_save_recorded`. The agent then runs and maintains it. _(First cut: structured
annotations only — see below; free natural-language annotations are future work.)_

### What a flow file looks like

```jsonc
{
  "version": 1,
  "name": "create-task",
  "steps": [
    { "tool": "iris_act", "anchor": { "testid": "add-task" }, "action": "click" },
    {
      "tool": "iris_act",
      "anchor": { "testid": "add-task" },
      "action": "click",
      "expect": { "signal": "task:added" },
    },
  ],
  "dynamic": [], // anchors whose CONTENT must not be asserted (LLM output)
  "success": { "signal": "saved" },
}
```

Each step binds to a **semantic anchor**, never a `eXX` ref: a `testid`/`signal` when available,
else an auto-derived `component` anchor (component name + source `file:line`) for an element with no
testid — so the flow stays stable with zero hand-added testids. Only when none of those resolve is a
step kept `degraded: true` (a last-resort "add a testid here" marker) rather than silently dropped.

## Run a flow

```jsonc
iris_flow_list()                                    // → flows on disk
iris_flow_load({ flowName: "create-task" })   // → the flow JSON
iris_flow_replay({ flowName: "create-task" }) // re-resolve each anchor against the LIVE DOM, run it
```

`iris_flow_replay` returns a status:

- `ok` — every anchor resolved and every `expect` held.
- `drift` — an anchor missed (a testid was renamed, or a signal never fired). The result is
  **legible**: `{ step, anchor, drift: { reasonKind: "testid_not_found", nearest: "send-message" } }`
  — never a blind failure. (This is the "whose fault is it" principle.)
- `error` — the flow file is missing/invalid, or a resolved action failed. Runtime failures include
  the failed step and a top-level error envelope.

A testid-_preserving_ refactor (you moved markup but kept the testids) still replays green. A step
whose element has **no testid** is anchored on its component + source location
(`{ kind: "component", component, source: { file, line } }`) — an auto-derived stable anchor, so a
flow records cleanly with zero hand-added testids and replay re-resolves it via `iris_query by:'component'`.

### The decision envelope — what to do next, not just pass/fail

On a `drift` or `error`, the replay result carries a `decision` an agent can act on directly:

```jsonc
decision: {
  verdict: "drift",
  whatChanged: "testid \"fault-500\" not found",
  whereInSource: "src/Diagnostics.tsx:16",   // file:line, from the component/source anchor
  suggestedFix: "rebind the anchor to \"fault-404\" (closest survivor)",
  nextAction: "rebind the anchor to \"fault-404\", or update the flow if the change was intended."
}
```

This is the feedback a human reviewer used to give — made machine-actionable, so the agent decides
its next move without one.

## Verify the whole suite in one call

`iris_flow_verify` replays **every** saved flow (or a named subset) deterministically — no LLM per
flow — and returns one consolidated verdict. This is the regression check to run after any change:

```jsonc
iris_flow_verify()
// → { status: "fail", total: 4, passed: 3, failed: 1,
//     summary: "3/4 flows pass — 1 needs attention: ship-deploy",
//     failures: [{ flow: "ship-deploy", verdict: "drift",
//                  whatChanged: "...", whereInSource: "src/...:NN", nextAction: "..." }] }
```

Passing flows are counted; only failures carry detail (token-cheap). Build → `iris_flow_verify` →
fix from each failure's `nextAction` → repeat — the autonomous regression loop.

## Self-healing — the agent maintains the flow

When a testid is renamed, the flow drifts. `iris_flow_heal` proposes — and optionally applies —
the nearest-match rebind, so flows don't rot:

```jsonc
iris_flow_heal({ flowName: "create-task" })               // PROPOSE only — never writes
// → { status: "drift", applied: false,
//     proposals: [{ step: 0, from: "add-tassk", to: "add-task", confidence: 0.8 }] }

iris_flow_heal({ flowName: "create-task", apply: true })  // rewrite the anchor on disk
// → { status: "healed", applied: true, proposals: [...] }
```

With `apply: false` the flow file is **never modified** — you get the proposed diff to review.
With `apply: true` Iris rewrites the drifted anchor(s) to the confident nearest match and a
subsequent replay passes. A drift with **no** confident nearest match leaves the file untouched.

## Annotations (structured)

`iris_annotate` attaches a structured annotation that compiles into the flow, so replay is a
_checked_ re-run, not a blind macro:

- `assert-signal` / `assert-visible` → a step `expect` predicate (the invariant).
- `mark-dynamic` → a `flow.dynamic[]` entry — replay asserts the region's _presence_ but **not
  its words** (the LLM-output case: assert `caption:generated`, ignore the caption text).
- `success-state` → `flow.success` (the golden end condition).

## Flows are your test suite

`.iris/` flows can be executed as CI specs — replayed with their `expect`/`success` predicates,
skipping `dynamic` regions — via `@syrin/iris-test`'s `flowsAsSpecs`. See
[Testing with Iris](testing.md).

## Tool reference

| Tool                                     | Args                     | Returns                                                 |
| ---------------------------------------- | ------------------------ | ------------------------------------------------------- |
| `iris_contract_save`                     | `{ sessionId? }`         | writes `.iris/contract.json`                            |
| `iris_record_start` / `iris_record_stop` | `{ recordingName }`      | start/stop capturing the agent's acts                   |
| `iris_flow_save`                         | `{ flowName }`           | persist the recording → `.iris/flows/<flowName>.json`   |
| `iris_flow_save_recorded`                | `{ flowName? }`          | persist a human-recorded (toolbar) flow                 |
| `iris_flow_list`                         | `{}`                     | flows on disk                                           |
| `iris_flow_load`                         | `{ flowName }`           | the flow JSON                                           |
| `iris_flow_replay`                       | `{ flowName }`           | `{ status, steps, decision? }` (decision on drift/fail) |
| `iris_flow_verify`                       | `{ names?, sessionId? }` | suite verdict `{ status, passed, failed, failures[] }`  |
| `iris_flow_heal`                         | `{ flowName, apply? }`   | propose / apply nearest-match rebind                    |
| `iris_annotate`                          | `{ kind, … }`            | compile a structured annotation into the flow           |

> Flow `name` must be a single safe path segment (no `/`, `\`, `..`, or leading dot).
