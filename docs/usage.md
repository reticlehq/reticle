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

List connected tabs. → `{ sessions: [{ sessionId, url, title, lastSeenMs }] }`

### `iris_snapshot`

A semantic, accessibility-tree view of the page.

- **args:** `mode?: 'full' | 'interactive' | 'status'` (default `full`), `scope?` (CSS
  selector or ref), `sessionId?`.
- **returns:** `{ tree, status: { route, title, visibleDialogs }, nodes, truncated }`.

```jsonc
iris_snapshot({ mode: "interactive" })
// - tab "Overview" (ref=e2)
// - button "Add item" (ref=e5)
// status: { route: "/dashboard", visibleDialogs: [] }
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

Deep detail on one element.

- **args:** `ref`, `sessionId?`.
- **returns:** descriptor + `tag` + `box` + `styles { color, backgroundColor, opacity }` +
  `component { componentStack, source?: { file, line, column } }` (with `@iris/react`).

### `iris_act` / `iris_act_sequence`

Perform one action / several in order.

- **`iris_act` args:** `ref`, `action`, `args?`, `sessionId?`. → `{ since, result }` where
  `result = { ok, ref, action, effect }`.
- **`iris_act_sequence` args:** `steps: [{ ref, action, args? }]`. → `{ since, result }` where
  `result = { ok, count, effects: [...] }` (one `effect` per step).
- See [§5](#5-actions--full-list) for the action list.

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

Use it to distinguish failure modes: `visible:false`/`enabled:false`/`targetMatched:false` →
your action missed; the tool throwing → it never dispatched; `defaultPrevented:true` or all of
`valueChanged:false`/`focusMoved:null`/`domMutatedWithin:0` → the app didn't react.

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
  (event-type names), `sessionId?`.
- **returns:** `{ window_ms, events: [...], summary: { network, domAdded, domRemoved,
routeChanges, consoleErrors, animations, signals } }`.

### `iris_wait_for`

Block until a predicate holds (or time out). Looks both backward (recent buffer) and forward.

- **args:** `predicate`, `timeout_ms?` (default 4000), `sessionId?`.

### `iris_assert`

Verify a predicate; optionally wait for it.

- **args:** `predicate`, `timeout_ms?` (0 = evaluate once), `sessionId?`.
- **returns:** `{ pass, evidence, failureReason? }`. On failure includes a **near-miss**
  (e.g. "found the dialog but not visible", or "no button named 'Submit'; saw: Cancel").

### `iris_network` / `iris_console` / `iris_animations`

Fast targeted lookups without a full timeline.

- `iris_network({ since?, method?, urlContains?, status? })` → `{ calls }`
- `iris_console({ level?, since? })` → `{ logs }`
- `iris_animations()` → running/recent animations.

### `iris_baseline_save` / `iris_baseline_list` / `iris_diff`

Regression detection — [§8](#8-regression-baselines--diff).

### `iris_record_start` / `iris_record_stop`

Capture a flow's reaction report — [§9](#9-recording-a-flow).

### `iris_explore`

List interactive elements + console-error count for autonomous exploration — [§10](#10-autonomous-exploration).

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
```

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
```

```jsonc
iris_assert({ timeout_ms: 30000, predicate: {
  kind: "signal", name: "webhook:received", dataMatches: { provider: "stripe" } } })
```

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
iris_record_start({ name: "checkout" })
// …agent performs the flow (acts)…
iris_record_stop({ name: "checkout" })
// → { name, events: [...ordered timeline...], summary: { network, domAdded, … } }
```

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
Visual/pixel correctness and "does it feel right" remain human (or a visual-diff tool) — see
[coverage & limits](../plan/11-coverage-and-limits.md) if available.

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
