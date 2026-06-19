# Iris — Complete Usage Guide

The full reference and cookbook. If you haven't set up Iris yet, start with
[Getting Started](getting-started.md).

**Contents**

1. [How Iris helps you](#1-how-iris-helps-you)
2. [Core concepts](#2-core-concepts)
3. [The tools — full reference](#3-the-tools--full-reference)
4. [The predicate DSL — full reference](#4-the-predicate-dsl--full-reference)
5. [Actions — full list](#5-actions--full-list)
6. [Snapshot modes & scoping](#6-snapshot-modes--scoping)
7. [Cookbook: real situations](#7-cookbook-real-situations)
8. [Regression: baselines & diff](#8-regression-baselines--diff)
9. [Recording a flow](#9-recording-a-flow)
10. [Autonomous exploration](#10-autonomous-exploration)
11. [Turning your test cases into agent checks](#11-turning-your-test-cases-into-agent-checks)
12. [Token discipline](#12-token-discipline)
13. [Best practices & gotchas](#13-best-practices--gotchas)
14. [FAQ](#14-faq)
15. [Security & privacy](#15-security--privacy)

---

## 1. How Iris helps you

You mostly **talk to your agent in plain English** — "add X and verify it works." The agent
uses Iris under the hood. Here's the value, by situation:

- **You stop being the agent's eyes.** Today you build a feature, then _you_ click through the
  browser to check it. With Iris the agent checks its own work and only comes back when it's
  actually verified — or with a precise reason it failed.
- **Silent breakage gets caught.** A console error, a 500 on one locale, a button that
  quietly disappeared after a refactor — humans skim past these; Iris asserts on them.
- **The fix loop closes.** When something's wrong, Iris reports the _evidence_ — the failing
  network call, the console stack, and (on React) the **source file:line** to edit.
- **It's cheap enough to run constantly.** ~100 tokens per verified interaction means the
  agent can verify on _every_ edit, not just at the end (see [token-efficiency](token-efficiency.md)).
- **Your manual QA becomes automated.** The checklist you never turned into Playwright tests?
  Your agent runs it now (see [§11](#11-turning-your-test-cases-into-agent-checks)).

Who benefits most: anyone shipping **dashboards, internal tools, SaaS apps** — behavior-heavy
UIs with lots of forms, lists, modals, and API calls that change often.

---

## 2. Core concepts

**The loop: look → act → observe → assert.**

1. **Look** with `iris_snapshot` (what's on screen) or `iris_query` (find a specific thing).
2. **Act** with `iris_act` (click/fill/…). It returns a `since` cursor — a timestamp marker.
3. **Observe** with `iris_observe({ since })` — everything the app did _after_ that action.
4. **Assert** with `iris_assert({ predicate })` — verify it, get evidence.

**Refs.** Elements are addressed by stable handles like `e7`. You get them from `snapshot`
or `query`, then pass them to `act`/`inspect`. A ref re-resolves to its element across
re-renders; if the element is gone, you get a clear error.

**Evidence, not prose.** Every tool returns structured data — counts, the matching network
call, the snapshot delta — so the agent reasons over facts, not a vibe.

**Sessions.** Each connected browser tab is a session (named via `iris.connect({ session })`).
With one tab open you never specify it; with several, pass `sessionId`.

---

## 3. The tools — full reference

### `iris_sessions`

List connected tabs. → `{ sessions: [{ sessionId, url, title, lastSeenMs, hidden, focused, throttled }] }`.
`lastSeenMs` is the silence since the tab last reported (not time-since-connect); `throttled` is
`true` when the tab is hidden or has gone quiet — a throttled tab silently no-ops timers/rAF/pointer.

### `iris_snapshot`

A semantic, accessibility-tree view of the page.

- **args:** `mode?: 'full' | 'interactive' | 'status'` (default `full`), `scope?` (CSS
  selector or ref), `diff?: boolean`, `sessionId?`.
- **returns:** `{ tree, status: { route, title, visibleDialogs }, nodes, truncated, cost: { bytes, tokens } }`.
- **`diff: true`** returns only what changed since your last snapshot of the same scope/mode —
  `{ mode: 'delta', delta: { added, removed, addedCount, removedCount } }` or `{ mode: 'unchanged' }`
  (no full tree). The first call (and any call after a route change) still returns the full tree.
  ~99% fewer tokens to re-look after an action; see [token-efficiency.md](token-efficiency.md).
- **`cost`** is an estimated size of the result — re-scope (`mode`/`scope`) before reading if large.

```jsonc
iris_snapshot({ mode: "interactive" })
// - tab "Overview" (ref=e2)
// - button "Add item" (ref=e5)
// status: { route: "/dashboard", visibleDialogs: [] }

iris_snapshot({ diff: true }) // after an action — only the change set
// { mode: "delta", delta: { added: ['- alert "Saved!"'], removed: [], addedCount: 1, removedCount: 0 } }
```

### `iris_query`

Find elements (Testing-Library semantics).

- **args:** `by: 'role'|'text'|'label'|'placeholder'|'testid'|'alt'`, `value`, `name?`
  (for role), `scope?`, `sessionId?`.
- **returns:** `{ elements: [{ ref, role, name, value?, states, visible, text? }] }`.

```jsonc
iris_query({ by: "role", value: "button", name: "Save" })   // → ref + descriptor
```

### `iris_inspect`

Deep detail on one element — including the signals a snapshot/a11y tree omits, so you can tell
"present" from "actually usable / on-theme".

- **args:** `ref`, `sessionId?`.
- **returns:** descriptor + `tag` + `box` + `occluded` (another element covers its center — a
  z-index/overlay bug) + `styles { color, backgroundColor, opacity, cursor, display, visibility }` +
  `theme { colorToken, backgroundToken, offTheme, tokenCount }` (compliance vs the app's `:root`
  design tokens — `offTheme:true` flags an off-palette color) +
  `component { componentStack, source?: { file, line, column } }` (with `@syrin/iris-react`).
- Use it to catch present-but-broken UI: `opacity:0` / `box` 0×0 / `occluded:true` (invisible or
  unclickable), `cursor` not `pointer` (dead control), `offTheme:true` (off-design-token color).

### `iris_act` / `iris_act_sequence`

Perform one action / several in order.

- **`iris_act` args:** `ref`, `action`, `args?`, `refuseWhenThrottled?`, `sessionId?`. →
  `{ since, dispatched, settled, settleReason, result, session, warning? }`
  where `result = { ok, ref, action, dispatched, settled, settleReason, effect }`. The `session`
  block `{ lastSeenMs, throttled, focused }` (F2) reports tab health on every act; when `throttled`
  is true a `warning` string is also attached. Pass `refuseWhenThrottled: true` to hard-fail instead
  of warning (opt-in; default is warn-only so background testing never breaks).
- **`iris_act_sequence` args:** `steps: [{ ref, action, args? }]`. → `{ since, dispatched, result }` where
  `result = { ok, count, effects: [...], steps: [...] }` (one `effect` per step; each step carries its own
  `dispatched`/`settled`/`settleReason`).
- See [§5](#5-actions--full-list) for the action list.

**Dispatch vs settle (F1).** The action is two phases: the **dispatch** (the synchronous click/fill —
this is what can fail) and the **settle** (waiting one animation frame so React's commit lands before
we return). The settle is **bounded** (~200ms): in a throttled/background tab `requestAnimationFrame`
never fires, so Iris falls back to a timer and resolves anyway. A settle timeout is therefore **never an
error** — `iris_act` resolves with `settled:false, settleReason:"timeout"` and the dispatch (the click)
has still landed. Only a real dispatch failure (stale ref, wrong element type) throws.

| top-level field | meaning                                                                              |
| --------------- | ------------------------------------------------------------------------------------ |
| `dispatched`    | the action dispatched without throwing (mirror of `effect.dispatched`)               |
| `settled`       | a real animation frame flushed within the budget; `false` = the fallback timer fired |
| `settleReason`  | `"timeout"` when the fallback fired (throttled tab), else `null`                     |

**`result.effect` — best-effort evidence the action landed.** All probes are cheap and capture
only the _immediate_ effect (one microtask + one rAF after dispatch); async, network-driven
re-renders show up in `iris_observe`, not here.

| field              | meaning                                                                                                                                                                                                                                                                           |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dispatched`       | always `true` (if we couldn't dispatch, the tool throws instead)                                                                                                                                                                                                                  |
| `targetMatched`    | the ref still resolved to a connected element                                                                                                                                                                                                                                     |
| `visible`          | element was visible at the start of the action                                                                                                                                                                                                                                    |
| `enabled`          | element was not disabled / aria-disabled at the start                                                                                                                                                                                                                             |
| `defaultPrevented` | a handler called `preventDefault()` on the primary cancelable event. Only meaningful for `click`/`dblclick`/`hover`/`fill`/`type`/`clear`/`press`/`upload`/`drag`; always `false` for non-cancelable events (`focus`/`blur`/`select`/`check`/`uncheck`/`submit`/`scrollIntoView`) |
| `focusMoved`       | `"<prevRef>-><newRef>"` if `document.activeElement` changed, else `null` (body counts as `null`)                                                                                                                                                                                  |
| `valueChanged`     | `fill`/`type`/`clear` only: input value before !== after; otherwise `false`                                                                                                                                                                                                       |
| `domMutatedWithin` | count of MutationObserver records seen in the window                                                                                                                                                                                                                              |
| `occluded`         | `click`/`dblclick` only: the click point hit-tested to a _foreign_ element (an overlay is on top). Synthetic dispatch still delivered the event, but **a real user could not click it** — treat the target as visually blocked. `false` when not click-like or not hit-testable   |
| `occludedBy`       | the ref of the element actually on top at the click point when `occluded`, else `null`                                                                                                                                                                                            |
| `scrolledIntoView` | `click`/`dblclick` only: the target was off-viewport, so Iris scrolled it into view before dispatch                                                                                                                                                                               |

Use it to distinguish failure modes: `visible:false`/`enabled:false`/`targetMatched:false` →
your action missed; the tool throwing → it never dispatched; `occluded:true` → the control is
covered by something (a real user is blocked even though the synthetic event landed);
`defaultPrevented:true` or all of `valueChanged:false`/`focusMoved:null`/`domMutatedWithin:0` →
the app didn't react.

**Clicks run the code, they don't push pixels.** A `click`/`dblclick` fires the full
`pointerdown → mousedown → focus → pointerup → mouseup → click` sequence directly on the resolved
element — so pointer- and focus-gated handlers fire the way they do for a real user, with no
coordinate gesture to be intercepted by the presenter HUD or missed off-screen. This is the **default
even when native CDP real input is configured** (`inputMode:"synthetic"`,
`inputModeReason:"synthetic-click-preferred"`). Before dispatch Iris hit-tests the click point
(`occluded`) and scrolls an off-screen target in (`scrolledIntoView`), so a blocked or off-viewport
target is reported, never silently "successful". For the rare case that needs a **trusted** native
click — a native file picker, clipboard, or an `isTrusted`-gated handler — pass `args:{ native:true }`
to drive it through CDP. `hover`/`drag` still use native pointer input (they need real hit-testing).

**Cookbook — "Did my action even land?"**

```ts
const { result } = iris_act({ ref: saveBtn, action: 'click' });
if (result.effect.defaultPrevented) {
  // a handler blocked the default — the click was swallowed
} else if (result.effect.domMutatedWithin === 0) {
  // dispatched cleanly but the app rendered nothing — likely a dead control
}
```

### `iris_observe`

The timeline + summary of what happened.

- **args:** `window_ms?` (default 2000) **or** `since?` (cursor from an act), `filters?`
  (event-type names), `max_events?` (cap the timeline to the most recent N), `sessionId?`.
- **returns:** `{ window_ms, events: [...], summary: { network, domAdded, domRemoved,
routeChanges, consoleErrors, animations, signals }, cost: { events, bytes, droppedOldest? } }`.
- **Output budget.** Every result carries a `cost:{ events, bytes }` hint so you can self-budget your
  next call. When `max_events` truncates the timeline, the dropped count is surfaced as
  `cost.droppedOldest` — never a silent cap. (The presenter HUD's own animations are filtered out of
  the timeline automatically, so `observe` shows the app, not the instrument.)

### `iris_act_and_wait`

Act, then wait for a predicate — the whole act→observe→assert loop in one hop.

- **args:** `ref`, `action`, `args?`, `until: <predicate>`, `timeout_ms?` (default 4000;
  0 = evaluate once), `refuseWhenThrottled?`, `sessionId?`.
- **returns:** `{ effect, verdict, trace, session, warning? }` — `effect` is the action result
  (`{ ok, ref, action }`), `verdict` is `{ pass, evidence?, failureReason? }`, `trace` is the
  reaction report of everything the app did after the action, and `session` (F2) is the tab-health
  block `{ lastSeenMs, throttled, focused }` (with a `warning` when throttled). A failing `verdict`
  still returns `effect` + `trace` so you can see what _did_ happen. The predicate is automatically
  floored at this act's cursor, so it only matches events the action actually caused.

### `iris_wait_for`

Block until a predicate holds (or time out). Looks both backward (recent buffer) and forward.

- **args:** `predicate`, `timeout_ms?` (default 4000), `since?`, `sessionId?`.
- **No stale-signal false passes.** By default the evaluation window is floored at your **last
  act's cursor**, so a signal/network/console/animation event buffered _before_ the action can
  never satisfy the predicate (the report's "validation 68 == 68 was a lie" footgun). Pass an
  explicit `since` (an act/observe cursor) to widen or narrow the window deliberately. Element/text
  predicates query the live DOM and are unaffected by `since`.

### `iris_assert`

Verify a predicate; optionally wait for it.

- **args:** `predicate`, `timeout_ms?` (0 = evaluate once), `since?`, `sessionId?`.
- Same `since` default as `iris_wait_for`: scoped to your last act so a stale buffered event can't
  fake a pass; override with an explicit `since`.
- **returns:** `{ pass, evidence, failureReason?, session, warning? }`. On failure includes a
  **near-miss** (e.g. "found the dialog but not visible", or "no button named 'Submit'; saw: Cancel").
  The `session` block `{ lastSeenMs, throttled, focused }` (F2) reports tab health on every assert;
  when throttled a `warning` is attached so you never assert against a tab that is silently no-oping.

### `iris_network` / `iris_console` / `iris_animations`

Fast targeted lookups without a full timeline.

- `iris_network({ since?, method?, urlContains?, status? })` → `{ calls }`
- `iris_console({ level?, since? })` → `{ logs }`
- `iris_animations()` → running/recent animations.

### `iris_capabilities`

The app-advertised testable surface (registered via `iris.describe`). Call this first to learn
what to assert on without reading source.

- `iris_capabilities({ sessionId? })` → `{ testids, signals, stores, flows }`

`iris_sessions` also surfaces a `hasCapabilities` flag per session so you know when it's worth
calling. Returns empty arrays (never errors) if the app advertised nothing.

### `iris_domain`

Read the app's domain model **before testing**: a synthesis of every saved flow + the registered
capabilities. Tells you what to test and where the real risk is without crawling the app. Reads
`.iris/flows/` + `.iris/contract.json` — no browser needed.

- `iris_domain({})` → `{ flowCount, flows: [{ name, steps, grade, asserts, signals, testids, warning?, risk? }], declared: { testids, signals, stores }, coverage: { asserted, presenceOnly, assertionFree }, gaps: { unassertedFlows, declaredUntestedSignals, declaredUntestedTestids }, riskRanked, summary }`
- **`gaps`** is the point: `declaredUntestedSignals` are intents the app emits that **no flow
  asserts** (untested behavior); `unassertedFlows` act but verify no consequence. Close them with a
  flow + a consequence assertion (`iris_annotate`).
- **`riskRanked`** orders flow names worst-first by combining run history (`.iris/project.json`:
  recently failed/drifted, or passed-with-errors) with assertion quality (a green assertion-free
  flow is still risky). **Test these first.** Each flow's `risk` carries `{ level, reason, lastStatus? }`.

### `iris_state`

Read live framework/store state directly instead of inferring it from the DOM — [§17](#17-evidence-of-effect-actawait-state-capabilities-replay-m56).

- `iris_state({ store?, ref?, path?, depth?, sessionId? })` → `{ stores, component? }`, or
  `{ store, path, found, value, availableKeys?, storeNames }` when `path`/`depth` is given.

Store reads are the reliable path. The `ref` component read is best-effort and bounded: when the
component state can't be read it returns `component: { ok: false, reason: "component-state-unavailable" }`
rather than hanging.

**Scope big stores so you don't pay for them.** A whole store can be tens of KB. Narrow the read:

- `path` extracts a dot-path sub-tree relative to the named `store` (numeric segments index arrays),
  e.g. `iris_state({ store:"workspace", path:"captionCache.v3.0.text" })`.
- `depth` collapses anything deeper than N levels to a compact size marker (`{…7 keys}`,
  `[Array(120)]`) so you can skim a store's _shape_ before drilling in.
- A wrong `path` returns `{ found:false, availableKeys:[...] }` — the keys that _were_ present where
  the walk stopped — so a mistyped path is self-correcting, not a bare `null`.

### Detecting wasted re-renders (React)

A page can be **thrashing** — committing many React renders a second — while the DOM stays visually
identical. The DOM/screenshot tools see an idle page; only a tool inside the runtime sees the commit
rate. Iris exposes it as a registered store you read with `iris_state`:

```ts
// app entry — MUST run before react-dom loads, so import it FIRST (React reads the devtools hook
// at renderer-inject time). It augments a real React DevTools hook if present; host-safe (no-ops on
// any failure, never breaks the app).
import { installRenderMeter } from '@syrin/iris';
installRenderMeter();
```

```jsonc
iris_state({ store: "__iris_renders", path: "commits" })   // → total React commits (monotonic)
// read it, do an action (or wait a window), read again → the delta is the commit count for that span.
```

A render storm shows up as a commit count that climbs with no corresponding DOM mutation — a perf
regression invisible to any outside-the-page tool.

### `iris_narrate` / `iris_clock`

Show the agent's intent on the page, and control time (toasts/debounces/auto-dismiss) —
[§16](#16-presenter-mode-narration--fake-clock-watch--control).

### `iris_baseline_save` / `iris_baseline_list` / `iris_diff`

Regression detection — [§8](#8-regression-baselines--diff).

### `iris_record_start` / `iris_record_stop` / `iris_replay`

Capture a flow's reaction report and compile it into a replayable program — [§9](#9-recording-a-flow).
`iris_record_stop` also returns a `cost:{ events, bytes }` hint alongside the reaction report so you
can gauge the recording's size.

### `iris_explore`

List interactive elements + console-error count for autonomous exploration — [§10](#10-autonomous-exploration).

### Flows, recorder & self-healing (`.iris/`)

`iris_contract_save`, `iris_flow_save` / `iris_flow_save_recorded` / `iris_flow_list` /
`iris_flow_load` / `iris_flow_replay` / `iris_flow_verify`, `iris_flow_heal`, `iris_annotate` —
record once, replay forever (anchored on testid/signal — or an auto-derived component/source anchor
when there's no testid), with legible drift + self-heal. Full guide:
[Flows, the recorder & self-healing](flows.md).

- **`iris_flow_verify({ names?, sessionId? })`** — the regression-suite call: replays EVERY saved
  flow (or a subset) deterministically and returns one verdict
  `{ status, passed, failed, failures: [{ flow, verdict, whatChanged, whereInSource, nextAction }] }`.
  Passing flows are counted; only failures carry detail. Run it after any change — one call, no LLM
  per flow.
- **Decision envelope:** on a drift/fail, `iris_flow_replay` (and each `iris_flow_verify` failure)
  returns the actionable fix — `whatChanged`, `whereInSource` (`file:line`), and a one-line
  `nextAction` (e.g. "rebind the anchor to 'new-deploy', or update the flow if intended").

### Human-in-the-loop control

`iris_end_session`, `iris_resume`, `iris_messages` — the human can pause the agent, send it a
correction, or end the session from the floating panel; the agent receives guidance on its next
tool call. Full guide: [Human-in-the-loop control](human-control.md).

### `iris_review` — drain the bugs the human flagged on the page

The dev clicks **"Flag a bug"** in the running app, points at the element that looks wrong, and types
what's wrong (⌘/Ctrl+Enter to send). Each flag becomes a **mark** the agent drains:

```
iris_review({ sessionId })
→ { marks: [{ id: "m1", note: "this button is misaligned", label: "button \"Pay\"",
              source: { file: "src/Checkout.tsx", line: 42 },
              fix: "Open src/Checkout.tsx:42 and fix: this button is misaligned. Then iris_review { resolve: \"m1\" }" }],
    pendingCount: 1 }
```

Each pending mark carries the human note, the element label, the source **`file:line`** (when the
framework stamped one), and a ready-to-act `fix` hint. Open the file, apply the fix, then
`iris_review({ resolve: "m1" })` — the human watching the panel sees **"✓ fixed: …"** land. Reading
never consumes a mark, so you can list → fix → verify → resolve. `iris_sessions` also reports
`pendingMarks` so you notice flagged bugs during normal orientation.

### `iris_network_mock` — stub the network for error-state testing (driven mode)

On a page Iris drives (`iris drive`), make a request return a 500, force it offline, or delay it — so
testing error/edge states is one declared rule, no backend changes:

```
iris_network_mock({ mocks: [{ urlContains: "/api/pay", method: "POST", status: 500 }] })
→ { applied: true, count: 1 }      // now the checkout POST returns 500 — verify the failure UI
iris_network_mock({ mocks: [{ urlContains: "/api/feed", abort: true }] })   // simulate offline
iris_network_mock({ clear: true }) // turn mocking off
```

First matching rule wins (`urlContains` + optional case-insensitive `method`). Needs a driven browser;
without one it returns a `recommendation` pointing at `iris drive`.

---

## 4. The predicate DSL — full reference

A **predicate** declares what should be true. `iris_assert` / `iris_wait_for` evaluate it
against the live DOM + the event buffer.

### Leaf predicates

```jsonc
// An element exists / is in a state
{ "kind": "element", "query": { "role": "dialog", "name": "Confirm" }, "state": "visible" }
// query supports: role, name, text, label, placeholder, testid, alt, scope
// state: visible | hidden | enabled | disabled | checked | expanded | focused | present
// add "absent": true to assert it is NOT there (regression / removal)

// Visible text anywhere (optionally scoped via an element query instead)
{ "kind": "text", "contains": "Saved successfully", "visible": true }

// A network call happened
{ "kind": "net", "method": "POST", "urlContains": "/api/order", "status": 200, "since": 1820 }

// Navigation
{ "kind": "route", "pathname": "/success" }          // or: "contains": "/success"

// Console / errors
{ "kind": "console", "level": "error", "absent": true }   // "no errors during this flow"

// Animation
{ "kind": "animation", "name": "dialog-in", "completed": true }

// An app-emitted signal (webhook/websocket/store change you surfaced via iris.signal)
{ "kind": "signal", "name": "webhook:received", "dataMatches": { "provider": "stripe", "id": "*" } }

// A registered store's VALUE — the source of truth no DOM/network read can reach. Walks a dot-path
// (numeric array indices) and matches `equals`: a literal, omitted = presence, or a
// { $gte | $lte | $gt | $lt | $contains | $length } operator pattern. Catches a UI-vs-store desync
// (a deploy that only LOOKS shipped) deterministically, in one call — no LLM, no DOM scraping.
{ "kind": "state", "store": "app", "path": "deployments.0.status", "equals": "live" }
```

A `state` assertion is graded as a **consequence** (a wrong element or stale render cannot fake it),
and is usable the same three ways anywhere predicates flow: ad-hoc (`iris_assert` / `iris_act_and_wait`
`until`), as a flow step invariant (`iris_annotate { kind: "assert-state", statePath, store?, equals? }`),
and as a flow's golden end-condition (`iris_annotate { kind: "success-state", statePath, … }`). On a
miss it names the real store value and the keys that were available — legible, not a blind fail.

### Combinators

```jsonc
{ "allOf": [ <predicate>, <predicate>, … ] }   // every one must hold
{ "anyOf": [ <predicate>, … ] }                // at least one
{ "not": <predicate> }
```

### Timing

- `timeout_ms` (on `assert`/`wait_for`): wait up to N ms for it to become true.
- `since` (on `net`/`console` leaves): only consider events after this cursor (from `act`).

`dataMatches` uses shallow JSON matching; `*` means "present, any value".

---

## 5. Actions — full list

`iris_act({ ref, action, args })`:

| action               | args                        | notes                                                         |
| -------------------- | --------------------------- | ------------------------------------------------------------- |
| `click` / `dblclick` | —                           | dispatches a real click                                       |
| `hover`              | —                           | `mouseover`+`mouseenter` (triggers JS hover state)            |
| `focus` / `blur`     | —                           |                                                               |
| `fill`               | `{ value }`                 | sets value via React-safe native setter + `input`/`change`    |
| `type`               | `{ text }`                  | appends to current value                                      |
| `clear`              | —                           | empties an input                                              |
| `select`             | `{ value }`                 | `<select>` option                                             |
| `check` / `uncheck`  | —                           | checkbox/radio                                                |
| `submit`             | —                           | submits the element's `<form>`                                |
| `press`              | `{ key }`                   | keydown/up (default `Enter`)                                  |
| `scrollIntoView`     | —                           |                                                               |
| `upload`             | `{ name, content?, type? }` | sets a file on `<input type=file>`                            |
| `drag`               | `{ toRef }`                 | pointer-based drag (dnd-kit / rbd) + HTML5 DnD                |
| `webmcp`             | `{ tool, params }`          | calls a `navigator.modelContext` tool if the site exposes one |

---

## 6. Snapshot modes & scoping

`iris_snapshot` has three modes — pick the cheapest that answers your question:

- **`status`** (~30 tokens) — route, visible dialogs, counters. "Where am I, is a modal open?"
- **`interactive`** (~100 tokens) — only actionable elements (buttons, inputs, tabs…). "What
  can I click?" Non-interactive content (e.g. 1,000 list rows) is skipped.
- **`full`** — the whole semantic tree. Use only when you truly need everything.

**`scope`** narrows any snapshot or query to a subtree — a CSS selector
(`scope: "[data-testid=item-list]"`) or a ref. This is the main lever for keeping payloads
small and queries unambiguous on big pages.

---

## 7. Cookbook: real situations

Each is phrased as the situation you're in, then how the agent verifies it.

### "I told the AI to add an icon button that opens a modal"

```jsonc
const { since } = iris_act({ ref: iconBtn, action: "click" })
iris_assert({ timeout_ms: 2000, predicate: { allOf: [
  { kind: "element", query: { role: "dialog" }, state: "visible" },
  { kind: "console", level: "error", absent: true }
]}})
```

### "I changed an API call — did it fire correctly and update the UI?"

```jsonc
const { since } = iris_act({ ref: saveBtn, action: "click" })
iris_assert({ timeout_ms: 3000, predicate: { allOf: [
  { kind: "net", method: "PUT", urlContains: "/api/profile", status: 200, since },
  { kind: "text", contains: "Saved", visible: true }
]}})
```

### "I clicked a button and it should add an element on another page/section"

Act in section A, navigate to B, assert there:

```jsonc
iris_act({ ref: notifyBtn, action: "click" })            // in "Items"
iris_act({ ref: notificationsTab, action: "click" })     // go to "Notifications"
iris_assert({ timeout_ms: 2000,
  predicate: { kind: "text", contains: "New item queued", visible: true } })
```

### "Data shows up only after ~30s (eventual consistency) — how to refresh and see it"

```jsonc
const { since } = iris_act({ ref: addBtn, action: "click" })
iris_assert({ predicate: { kind: "net", urlContains: "/api/items", status: 202, since } }) // accepted
iris_assert({ predicate: { kind: "element",
  query: { text: name, scope: "[data-testid=item-list]" }, absent: true } })               // not yet
// …later: click your Refresh button, then wait for it…
iris_act({ ref: refreshBtn, action: "click" })
iris_wait_for({ timeout_ms: 5000, predicate: { kind: "element",
  query: { text: name, scope: "[data-testid=item-list]" }, state: "visible" } })
```

### "The list has 100s/1000s of rows — was my item actually added?"

Don't scroll and eyeball — query finds it regardless of position:

```jsonc
iris_assert({ timeout_ms: 3000, predicate: { kind: "element",
  query: { text: "Invoice #4821", scope: "[data-testid=item-list]" }, state: "visible" } })
```

> Note: if your list is **virtualized** (react-window/virtuoso), off-screen rows aren't in
> the DOM yet — scroll-to-find support is on the roadmap; for now scroll the container or
> assert against the data via an `iris.signal`.

### "Login form — does it actually authorize?"

```jsonc
iris_act({ ref: emailRef, action: "fill", args: { value: "admin@acme.com" } })
iris_act({ ref: pwRef, action: "fill", args: { value: "•••••••" } })
const { since } = iris_act({ ref: submitRef, action: "click" })
iris_assert({ timeout_ms: 3000, predicate: { allOf: [
  { kind: "net", method: "POST", urlContains: "/api/login", status: 200, since },
  { kind: "element", query: { role: "heading", name: "Dashboard" }, state: "visible" }
]}})
// And the failure path:
iris_assert({ predicate: { allOf: [
  { kind: "net", urlContains: "/api/login", status: 401 },
  { kind: "element", query: { role: "alert" }, state: "visible" }
]}})
```

### "Make sure there are NO console errors"

```jsonc
iris_assert({ predicate: { kind: "console", level: "error", absent: true } })
```

### "A real LLM call generates a script — is it happening and rendering?"

```jsonc
const { since } = iris_act({ ref: generateBtn, action: "click" })
iris_assert({ timeout_ms: 15000, predicate: { allOf: [
  { kind: "net", method: "POST", urlContains: "/api/generate", status: 200, since },
  { kind: "element", query: { testid: "script-output" }, state: "visible" }
]}})
```

### "Upload a file → it calls an LLM → a modal shows a score"

```jsonc
iris_act({ ref: fileInput, action: "upload", args: { name: "pitch.mp4", type: "video/mp4" } })
const { since } = iris_act({ ref: analyzeBtn, action: "click" })
iris_assert({ timeout_ms: 15000, predicate: { allOf: [
  { kind: "net", method: "POST", urlContains: "/api/score", status: 200, since },
  { kind: "element", query: { role: "dialog", name: "Score result" }, state: "visible" },
  { kind: "text", contains: "/ 100", visible: true }
]}})
```

### "A button's color should change on hover"

```jsonc
const before = iris_inspect({ ref }).styles.backgroundColor
iris_act({ ref, action: "hover" })
const after  = iris_inspect({ ref }).styles.backgroundColor
// assert before !== after
```

> Pure CSS `:hover` styling needs a real pointer; drive hover effects from JS state (or use a
> Playwright real-hover) if you need pixel-exact `:hover`. Iris reads computed style after the
> JS state change.

### "Something off-DOM happened — a webhook arrived, a store changed"

Surface it from your app, then assert on it:

```ts
// in your app
iris.signal('webhook:received', { provider: 'stripe', event: 'payment_intent.succeeded' });
iris.state('cart', { items: 3 });

// Advertise your testable surface at init so the agent learns it without reading source.
// Call this once at module load (before connect); it merges idempotently across HMR reloads.
iris.describe({
  testids: ['cart-badge', 'toast'],
  signals: ['webhook:received'],
  stores: ['cart'],
  flows: [{ name: 'checkout', steps: ['fill address', 'pay', 'see confirmation'] }],
});
```

The agent reads this back with `iris_capabilities()` — see [§3](#3-tool-reference).

```jsonc
iris_assert({ timeout_ms: 30000, predicate: {
  kind: "signal", name: "webhook:received", dataMatches: { provider: "stripe" } } })
```

#### Keeping signals from drifting (lint)

Signals only help if you actually emit one whenever user-visible state changes. The
`@syrin/iris-eslint-plugin` package ships one rule, `iris/require-signal-on-mutation`, that flags any
function which calls a configured store **mutator** but never fires the **signal callee** in
the same body — so the signal map can't silently fall behind the store.

```js
// eslint.config.mjs
import iris from '@syrin/iris-eslint-plugin';

export default [
  {
    plugins: { iris },
    rules: {
      'iris/require-signal-on-mutation': [
        'error',
        { mutators: ['set', 'reorderSections', 'addSection'], signalCallee: 'irisSignal' },
      ],
    },
  },
];
```

`mutators` lists the callee names that change state; `signalCallee` (default
`['irisSignal', 'signal']`) is the name that counts as firing a signal. See
[`packages/eslint-plugin/README.md`](../packages/eslint-plugin/README.md) for scoping and
matching details.

---

## 8. Regression: baselines & diff

The "did anything silently break/disappear?" workflow.

```jsonc
// after you've confirmed a screen is good:
iris_baseline_save({ name: "checkout-ok" })

// later, after a change:
iris_diff({ baseline: "checkout-ok" })
// → { removed: ["- button \"Export\""], added: ["- alert \"Card declined\""],
//     consoleErrors: 2, routeChanged: false }
```

`diff` ignores volatile ref ids and compares the semantic structure, so you get real
ADDED/REMOVED elements plus the current console-error count. Great as a guardrail the agent
runs after each edit: _"diff against `checkout-ok`; fail if anything interactive was removed
or console errors increased."_

---

## 9. Recording a flow

Capture everything that happens across a span — useful for "run my whole checkout flow and
tell me what happened," or to keep a known-good trace.

```jsonc
iris_record_start({ recordingName: "checkout" })
// …agent performs the flow (iris_act / iris_act_sequence)…
iris_record_stop({ recordingName: "checkout" })
// → {
//     recordingName,
//     program: { version, steps: [{ tool, args: { by:"testid", value, action, args }, stable }] },
//     events: [...ordered timeline...],
//     summary: { network, domAdded, … },
//     warning?  // present when some steps could not be bound to a testid
//   }
```

`iris_record_stop` returns a compiled, replayable `program`: the agent's `iris_act` /
`iris_act_sequence` invocations captured during the span, with each ref normalized to its
element's `data-testid` where resolvable. Re-run it later:

```jsonc
iris_replay({ recordingName: "checkout" })
// re-resolves each step by testid and re-runs the actions in order
// → { recordingName, ok, steps: [{ tool, ok, error?, note? }] }   // stops at the first failure
```

**Limitation.** Normalization to a stable testid only works for elements that have a
`data-testid`. A step whose element has none is stored in ref form (`stable: false`) and
`iris_record_stop` returns a `warning`; replay best-effort re-uses the stored ref, which is
only valid within the same live session and is not portable across reloads. Add `data-testid`
to the elements you want replay-stable.

---

## 10. Autonomous exploration

Have the agent crawl and stress a screen without a script:

```jsonc
iris_explore({ scope: "main" })
// → { interactive: [ { ref, desc }, … ], consoleErrors, hint }
```

The agent then acts on each ref, observes the reaction, and reports anomalies (failed
requests, console errors, dead controls). Good for "click everything on this page and tell me
what breaks."

---

## 11. Turning your test cases into agent checks

If you already have test cases — a QA checklist, acceptance criteria, a spreadsheet, manual
steps — you can hand them to your agent and have it run + verify each against the live app.
Each case becomes a predicate:

| Test case (English)                                  | Iris check                                                         |
| ---------------------------------------------------- | ------------------------------------------------------------------ |
| Login with valid creds lands on the dashboard        | `allOf[ net /api/login 200, element heading "Dashboard" visible ]` |
| Submitting the form shows a success toast            | `text "Saved" visible` (+ `net … 200`)                             |
| Deleting an item removes it from the list            | `element {text, scope:list}` `absent: true`                        |
| No console errors on the checkout page               | `console level:error absent:true`                                  |
| Export button visible for admins, hidden for viewers | `element {role:button, name:Export}` `visible` / `absent`          |
| Clicking a row opens the detail drawer               | `element {role:dialog}` `visible`                                  |

A practical workflow:

> "Here are our 12 dashboard test cases. For each, drive the app with Iris and tell me
> pass/fail with evidence. For any failure, show the source file to fix."

This is the sweet spot: the **manual cases you never automated** become things the agent runs
in seconds, on every change. It **complements** your CI Playwright/Cypress suite (which gates
releases) — Iris is the in-loop checklist while you build.

---

## 12. Token discipline

Iris is cheap by design ([benchmark](token-efficiency.md)), but keep it that way:

- Prefer **`iris_query` + `iris_assert`** (~30 tokens each) over snapshots inside the loop.
- Use **`mode: "interactive"`** or **`"status"`**, not `"full"`.
- Use **`scope`** to look at just the relevant subtree.
- Reach for `mode: "full"` only when you truly need the whole page.

---

## 13. Best practices & gotchas

- **Accessibility = legibility.** Real `role`s, labels, and `data-testid`s make queries
  precise and stable. It's also just good a11y.
- **Stable handles for controls.** Prefer `data-testid` over names that include dynamic
  counts (e.g. "Notifications (3)") — the count changes the accessible name.
- **Always thread `since`.** Pass the cursor from `iris_act` into `observe`/`assert` so you
  only consider what happened _after_ the action.
- **Use `timeout_ms` for async.** Don't assert instantly on something that arrives over the
  network or after a re-render.
- **Watch `session.throttled` (F2).** Background tabs throttle timers/rAF/pointer gestures, so
  an act can silently no-op. Every `iris_act` / `iris_assert` / `iris_act_and_wait` result carries
  `session: { lastSeenMs, throttled, focused }` and, when throttled, a `warning`. Refocus the tab
  (or run it foregrounded) before driving; pass `refuseWhenThrottled: true` to hard-fail instead.
- **Scope big pages.** On dashboards with hundreds of elements, scope queries to the panel
  you care about.
- **Never breaks your app.** Observers are additive and reversible (`iris.disconnect()`
  restores patched globals). It won't interfere with your app's behavior.

---

## 14. FAQ

**Does this run in production?** No — keep `iris.connect()` behind a dev guard. The SDK is
side-effect-free and tree-shakes out of prod builds.

**Do I have to change my components?** No, for basic look/act/observe. You'll get better
results by adding `data-testid`s and labels where the agent needs precision.

**Does it work without React?** Yes — the core (DOM/network/route/console/animation/snapshot/
actions) is framework-agnostic. React gets component + source mapping; Vue/Svelte adapters
are on the roadmap.

**Can it judge whether my UI _looks_ good?** No. Iris verifies behavior, not aesthetics.
Visual/pixel correctness and "does it feel right" remain human (or a visual-diff tool).

**Does it replace Playwright/Cypress?** No — those are your scripted CI suite. Iris is for
in-loop verification while the agent codes, and for the cases you never automated. They
compose.

**How does it compare to Playwright MCP / Chrome DevTools MCP?** Those let an agent drive/
inspect a _separate_ browser; Iris verifies your _own running app_ (real session/auth) with
assertions + regression as first-class, far more cheaply. See the README comparison.

**Multiple tabs/apps?** Each is a session; pass `sessionId` to any tool when more than one is
connected (`iris_sessions` lists them).

---

## 15. Security & privacy

- **Dev-only, localhost-only by default.** The bridge binds `127.0.0.1`; the SDK is meant for
  dev builds.
- **No telemetry.** Nothing phones home. Baselines/recordings are local.
- **Network bodies aren't captured by default** — only method/url/status/timing. Body capture
  is opt-in and runs through a redactor (drop `password`/`token`/`secret`/… + your patterns).
- **Additive & reversible.** Iris patches `fetch`/History/console defensively and restores
  them on disconnect; it will not break the app under test.

---

## 16. Presenter mode, narration & fake clock (watch + control)

### Presenter mode — let a human watch the agent

Turn it on when connecting:

```ts
iris.connect({ session: 'my-app', present: true, pace: 450 });
```

You get, in the page itself:

- a **glowing border** while the agent is working,
- a **synthetic cursor** that flies to each target before acting,
- **click ripples, hover rings**, and a status **HUD** ("Clicking button \"Save\"… ✓ passed"),
- a per-action **pacing** delay (`pace`, ms) so a human can follow.

All presenter DOM uses `data-iris-*` and is excluded from snapshots/observers, so it never
pollutes what the agent sees. Use `setIgnoreSelectors([...])` to also hide your own dev
widgets.

#### Session liveness — the HUD never gets stuck "running"

A session starts on the agent's first activity and must reliably end even when the agent
misbehaves. Iris is an MCP tool, so the agent (Claude) can crash, disconnect, or simply forget
to call `iris_end_session` — and a backgrounded tab's own timers are throttled by the browser.
So **the Node server owns liveness, not the browser tab:**

- **Agent goes idle / forgets to end** → a server-side reaper (immune to tab throttling) ends the
  session after `idleEndMs` of no agent commands and pushes the end to the browser. A backgrounded
  tab still receives that push, so you can switch windows and come back to a correctly-ended HUD.
- **Agent (MCP client) disconnects cleanly** → every active session ends at once.
- **Agent kills the Iris server process** (so no push can arrive) → the SDK self-ends the session
  after it can't reach the bridge for `BRIDGE_LOST_MS` (~15s), showing "lost connection to Iris."
- **Slow-but-alive agent** → if it goes quiet long enough to auto-end and then acts again, the
  session **revives** automatically (an explicit `iris_end_session` stays terminal).

Tune the idle window with `iris_session({ idleEndMs })` — it updates both the browser timer and
the server reaper. The human keeps the panel (with Copy/Export of the run) after any end.

### `iris_narrate` — show the agent's intent

So the human sees _what the agent is about to do and why_:

```jsonc
iris_narrate({ text: "Adding a beat, then checking the section count goes up" })
```

It renders on the HUD. (The agent's private reasoning isn't visible to Iris — narration is
how it surfaces intent on the page.)

### `iris_clock` — control time deterministically

Fast-forward toasts, debounces, auto-dismiss, and commit-on-blur without waiting:

```jsonc
iris_clock({ freeze: true })          // freeze app timers (Date.now/setTimeout/setInterval)
iris_act({ ref: e9, action: "click" })
iris_clock({ advanceMs: 5000 })       // jump 5s — the auto-dismiss fires now, deterministically
iris_assert({ predicate: { kind: "element", query: { role: "alert" }, absent: true } })
iris_clock({ reset: true })           // restore real timers
```

It does **not** freeze `requestAnimationFrame`/microtasks (React's scheduler keeps running),
and Iris's own internal timers are insulated, so freezing never stalls the tools.

### Action refinements (from real-app use)

- **`blur`** now fires a bubbling `focusout`, so React's commit-on-blur (`onBlur`) runs —
  inline editors and form fields commit. `fill`/`type` focus first so a later `blur` commits.
- **`hover`** accepts `{ holdMs }` to dwell, so timer-gated reveals mount; then `wait_for`
  the revealed nodes.
- **`drag`** yields a frame between phases (React flushes between steps) and accepts
  `{ data: { mime, value } }` for custom `dataTransfer` payloads.

### Richer `dataMatches` (signals)

```jsonc
{
  "kind": "signal",
  "name": "chat:edit-applied",
  "dataMatches": { "count": { "$gte": 1 }, "sections": { "$contains": "hook" } },
}
// operators: $gte $lte $gt $lt $contains (array/substring) $length ; "*" = present
```

On a failed signal assert, the result includes a **near-miss**: the signals that _did_ fire
with that name + their data. And `iris_observe`'s summary now includes `domChanged` (in-place
text/attribute re-renders, not just added/removed nodes).

---

## 17. Evidence-of-effect, act+await, state, capabilities, replay (M5.6)

These close the "is the action trusted?" gap — so you can tell _my action missed_ vs _the
app didn't react_ vs _the tool didn't dispatch_.

### `iris_act` returns evidence-of-effect

Every `iris_act` result now carries an `effect`:

```jsonc
{ since, dispatched, settled, settleReason,
  result: { ok: true, ref, action, dispatched, settled, settleReason, testid,
  effect: { dispatched, targetMatched, visible, enabled, defaultPrevented,
            focusMoved: "e11->e12"|null, valueChanged, domMutatedWithin } } }
```

`settled:false, settleReason:"timeout"` means the settle frame did not flush within the budget
(a throttled/background tab) — this is **not** a failure: the dispatch landed and the tool resolved.

Read it to disambiguate failures instantly: `targetMatched:false` = your ref was stale;
`defaultPrevented:true` = a handler cancelled it; `domMutatedWithin:0` + `valueChanged:false`
= the app didn't react.

### `iris_act_and_wait` — one hop for act → observe → assert

```jsonc
iris_act_and_wait({ ref, action, args?, until: <predicate>, timeout_ms })
// → { effect, verdict: { pass, evidence, failureReason? }, trace: <reaction report> }
```

Performs the action (with settle so React commits land in the window), waits for `until`, and
returns the action's effect + the verdict + the full causal trace. Collapses four calls into
one.

### `iris_state` — read live framework/store state

No need to broadcast a signal for every fact. Register stores in your app:

```ts
import { registerStore } from '@syrin/iris';
registerStore('workspace', () => useWorkspace.getState());
```

```jsonc
iris_state({ store: "workspace" })   // → { stores: { workspace: {…} } }
iris_state({ ref: "e9" })            // → { component: { ok: true, component, hooks } } or { component: { ok: false, reason: "component-state-unavailable" } }

// Scope a large store instead of paying for the whole thing:
iris_state({ store: "workspace", path: "captionCache.v3" })  // → { found: true, value: {…} }
iris_state({ store: "workspace", depth: 1 })                 // → top-level keys, deeper values collapsed to "{…N keys}"
iris_state({ store: "workspace", path: "nope" })             // → { found: false, availableKeys: ["captionCache", "version", …] }
```

Store reads are the reliable path; ref reads degrade to a structured failure rather than blocking.
`path` (dot-path, numeric segments index arrays) and `depth` keep a 60KB store from becoming a token
tax — and a wrong `path` returns the keys that _were_ there, so it's self-correcting.

### `iris_capabilities` — the app's testable surface

Declare it once so the agent learns the surface without reading source:

```ts
import { registerCapabilities } from '@syrin/iris';
registerCapabilities({ testids: [...], signals: [...], stores: [...], flows: [...] });
```

```jsonc
iris_capabilities()   // → { testids, signals, stores, flows }
```

### `iris_replay` — recordings become re-runnable programs

`iris_record_start` → drive the flow → `iris_record_stop` returns a **compiled program**
(steps bound to testids/signals, not volatile refs). `iris_replay({ recordingName })` re-executes it —
your flow becomes a deterministic regression run, not a checklist.

---

## 18. Real input mode — native hover & drag (M5.8)

Iris drives actions by dispatching JS events from inside the page. That covers click, fill,
type, select, submit, press, and HTML5 drag — but it **cannot** trigger browser-native pointer
behavior: `onMouseEnter`/`onMouseLeave`, hover-gated reveals, and pointer-library drags rely on
the browser's real hit-testing, which synthetic events don't drive.

**Clicks are synthetic by default — on purpose.** Even with real input configured, `click`/`dblclick`
run the occlusion-honest synthetic path (full `pointerdown→…→click` sequence + a `occluded` hit-test +
off-viewport auto-scroll), reporting `inputModeReason:"synthetic-click-preferred"`. There's no
coordinate gesture for the presenter HUD to intercept or to miss off-screen, and synthetic dispatch
reaches the resolved element directly. Reserve native clicks for the rare `isTrusted`-gated case
(native file picker, clipboard) with `args:{ native:true }`. Real input remains the path for
`hover`/`drag`, which genuinely need the browser's hit-testing. Every `iris_act` result tells you
which path ran:

```jsonc
{ since, dispatched, settled, inputMode: "synthetic" | "real", inputModeReason?, result, session, warning? }
```

When `inputMode` is `"synthetic"` and the target has hover/enter handlers, the result carries a
`warning` so you know a hover may be a no-op — you never have to reverse-engineer it.

**`inputModeReason` — never a silent fallback.** When real input **is** configured but a pointer
act still ran synthetic, the result says _why_, so per-element inconsistency is diagnosable
instead of mysterious:

| `inputModeReason`                      | meaning / fix                                                                                                                         |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `page-not-correlated-to-a-cdp-target`  | no CDP page matches the session URL — usually a fresh tab or a CDP target that isn't this page                                        |
| `element-not-locatable`                | the element had no box (off-screen / stale ref) — `scrollIntoView` first                                                              |
| `drag-target-unresolved`               | a drag's `toRef` was missing or not locatable                                                                                         |
| `provider-declined` / `provider-error` | the CDP provider declined or threw (the latter also sets `warning`)                                                                   |
| `not-a-pointer-action`                 | `fill`/`type`/etc. — these are always synthetic by design                                                                             |
| `synthetic-click-preferred`            | a `click`/`dblclick` ran the occlusion-honest synthetic path by default — pass `args:{ native:true }` to force a trusted native click |

(No `inputModeReason` is set when real input simply isn't configured — synthetic is the expected default there.)

### Enable real input (optional, opt-in)

Point Iris's server at a Chrome DevTools (CDP) endpoint; it then drives **real** pointer input
(via Playwright `connectOverCDP`) at the element's box for `hover`/`drag` (and for `click`/`dblclick`
only when you pass `args:{ native:true }` — clicks default to synthetic), and reports
`inputMode: "real"`.

1. Launch your browser with remote debugging:

   ```bash
   # Chrome/Chromium
   google-chrome --remote-debugging-port=9222 http://localhost:3000
   ```

2. Tell the Iris server where it is, via the MCP config `env`:

   ```jsonc
   // .mcp.json
   {
     "mcpServers": {
       "iris": {
         "command": "npx",
         "args": ["@syrin/iris"],
         "env": { "IRIS_CDP_URL": "http://localhost:9222" },
       },
     },
   }
   ```

That's it. Iris correlates the CDP page to your SDK session by URL; pointer actions now fire
native hover/enter so hover-gated suggestion panels, tooltips, and pointer-based drag become
drivable. Everything else is unchanged, and with no `IRIS_CDP_URL` set, Iris stays in the
synthetic (zero-dependency, in-page) mode — Playwright is an optional dependency loaded only
when you opt in.

> **SPA navigation is handled.** The URL correlation tracks client-side route changes
> (`pushState`/`replaceState`/`popstate`), so real input keeps working after your app navigates
> into a sub-route — e.g. the hover/quick-edit cluster on a `/workspace` view stays drivable.
> (Before 0.3.6 the reported session URL froze at load, so real input silently dropped to
> synthetic after the first SPA navigation; if you see `inputModeReason:"page-not-correlated-to-a-cdp-target"`,
> upgrade to ≥ 0.3.6.)

> **Watching the agent (presenter, M5.8).** With `present: true` the activity border now glows
> once while the agent is busy and fades when idle (no per-action strobe); the HUD sits
> **bottom-center**, shows a **READING** vs **ACTING** chip so you can tell observation from
> action at a glance, and `iris_narrate` lines are **queued** with a minimum on-screen dwell so
> none flash by unread.

> **Limitation — un-scriptable tabs.** Iris observes/drives a tab through the in-page SDK +
> (optionally) CDP; it **cannot bring to front or recover a browser tab the OS won't let it
> script** (e.g. a backgrounded or non-default-browser tab reporting `hidden:true`/`throttled:true`).
> When that happens, `iris_sessions` and every act/assert result carry a `session.recommendation`
> saying so and pointing to `iris drive <url>` for a guaranteed scriptable context — refocus the
> tab, or use `iris drive`.
