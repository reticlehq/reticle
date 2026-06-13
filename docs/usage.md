# Using Iris — a detailed guide

> Give your AI coding agent eyes into your running app, then have it **run your test cases**
> and verify them with evidence — without screenshots.

This guide covers: the mental model, install/wiring, the agent loop, writing checks (the
predicate DSL), turning existing test cases into agent checks, token discipline, and
gotchas.

---

## 1. The mental model: look → act → observe → assert

Iris is not a screenshot tool and not an external browser driver. Your app **instruments
itself** (a tiny dev-only SDK) and exposes its live behavior to your agent over MCP. The
agent works in a tight loop:

1. **Look** — `iris_snapshot` / `iris_query`: a compact, semantic view of what's on screen.
2. **Act** — `iris_act`: click / fill / type / select / submit / upload / drag / hover.
3. **Observe** — `iris_observe`: the timeline of what the app _did_ (DOM, network, route,
   console, animation, signals).
4. **Assert** — `iris_assert`: verify a predicate; get pass/fail **with evidence**.

The unit of work is _"I did X — did the right things happen?"_, answered from real runtime
facts, not pixels.

---

## 2. Install & wire it up

### a. The bridge + MCP server

```bash
npx @iris/server          # ws://localhost:4400 + MCP over stdio
```

Point your agent at it (e.g. Claude Code `.mcp.json`):

```jsonc
{ "mcpServers": { "iris": { "command": "npx", "args": ["@iris/server"] } } }
```

### b. The SDK in your app (dev only)

```ts
import { iris } from '@iris/browser';
if (import.meta.env.DEV) iris.connect({ session: 'my-app' });
```

It's tree-shaken from production and no-ops outside dev. No component changes are required
for basic look/act/observe.

### c. React extras (recommended)

```ts
import { install as installIrisReact } from '@iris/react';
if (import.meta.env.DEV) installIrisReact(); // DOM ref -> component stack -> source file
```

For **source-file mapping on React 19** (which removed `_debugSource`), add the babel plugin
to your dev build:

```ts
// vite.config.ts
import react from '@vitejs/plugin-react';
import irisSource from '@iris/babel-plugin';
export default defineConfig({ plugins: [react({ babel: { plugins: [irisSource] } })] });
```

### d. Non-DOM behavior (optional but powerful)

Surface things the DOM can't express so the agent can assert on them:

```ts
iris.signal('webhook:received', { provider: 'stripe', event: 'payment_intent.succeeded' });
iris.state('cart', { items: 3, total: 4200 });
```

---

## 3. The tools (quick reference)

| Tool                                                | Use                                                                |
| --------------------------------------------------- | ------------------------------------------------------------------ |
| `iris_sessions`                                     | list connected tabs                                                |
| `iris_snapshot`                                     | semantic snapshot — `mode: status \| interactive \| full`, `scope` |
| `iris_query`                                        | find elements by `role/text/label/placeholder/testid/alt`          |
| `iris_inspect`                                      | element detail + computed styles + component + **source file**     |
| `iris_act` / `iris_act_sequence`                    | perform action(s); returns a `since` cursor                        |
| `iris_observe`                                      | timeline + summary of what happened in a window                    |
| `iris_wait_for`                                     | block until a predicate holds (or time out)                        |
| `iris_assert`                                       | verify a predicate; returns `{ pass, evidence, failureReason }`    |
| `iris_network` / `iris_console` / `iris_animations` | fast targeted lookups                                              |
| `iris_baseline_save` / `iris_diff`                  | regression: snapshot now, diff later                               |
| `iris_record_start` / `iris_record_stop`            | capture a flow's reaction report                                   |
| `iris_explore`                                      | list interactive elements for autonomous exploration               |

---

## 4. The agent loop, worked

```jsonc
// 1) Look — what can I interact with?
iris_snapshot({ mode: "interactive" })
// → - textbox "Card number" (ref=e4)
//   - button "Pay $42.00" (ref=e7)

// 2) Act — fill + submit in one round-trip
iris_act_sequence({ steps: [
  { ref: "e4", action: "fill", args: { value: "4242 4242 4242 4242" } },
  { ref: "e7", action: "click" }
]})  // → { since: 1820 }

// 3) Observe — what did the app do after that?
iris_observe({ since: 1820 })
// → summary: { network: 1, domAdded: 2, consoleErrors: 0, animations: 1 }

// 4) Assert — verify the whole expectation in one call
iris_assert({ timeout_ms: 2000, predicate: { allOf: [
  { kind: "net", method: "POST", urlContains: "/api/order", status: 200 },
  { kind: "element", query: { role: "dialog", name: "Order confirmed" }, state: "visible" },
  { kind: "console", level: "error", absent: true }
]}})
// → { pass: true, evidence: { ... } }
```

On failure, `iris_assert` returns a diagnosis (near-miss, console errors, and — with the
React adapter — the source file), so the agent can fix and re-verify.

---

## 5. Writing checks — the predicate DSL

A predicate declares _what should be true_. Leaves:

```jsonc
{ "kind": "element", "query": { "role": "dialog", "name": "Order confirmed" }, "state": "visible" }
{ "kind": "element", "query": { "role": "button", "name": "Export" }, "absent": true }   // regression
{ "kind": "text", "contains": "Saved", "visible": true }
{ "kind": "net", "method": "POST", "urlContains": "/api/order", "status": 200 }
{ "kind": "route", "pathname": "/success" }
{ "kind": "console", "level": "error", "absent": true }
{ "kind": "animation", "name": "dialog-in", "completed": true }
{ "kind": "signal", "name": "webhook:received", "dataMatches": { "provider": "stripe" } }
```

Combinators + timing:

```jsonc
{ "allOf": [ ... ] }   { "anyOf": [ ... ] }   { "not": { ... } }
// `timeout_ms` on assert/wait_for waits for it to become true; `since` scopes events to after an action.
```

Element queries use Testing-Library semantics (role+name, text, label, testid…) and an
optional `scope` (CSS selector or ref) to narrow the search.

---

## 6. Recipes for the real-world tasks

These mirror the scenarios in the live demo (`apps/demo`).

**Login / authorization**

```jsonc
iris_act({ ref: emailRef, action: "fill", args: { value: "admin@iris.dev" } })
iris_act({ ref: pwRef, action: "fill", args: { value: "password" } })
const { since } = iris_act({ ref: submitRef, action: "click" })
iris_assert({ timeout_ms: 3000, predicate: { allOf: [
  { kind: "net", method: "POST", urlContains: "/api/login", status: 200, since },
  { kind: "element", query: { role: "tab", name: "Items" }, state: "visible" }
]}})
```

**Did an item get added to a (long) list?** — query finds it among 1000s without scrolling:

```jsonc
iris_assert({ timeout_ms: 3000,
  predicate: { kind: "element", query: { text: "Invoice #4821", scope: "[data-testid=item-list]" }, state: "visible" } })
```

**Server write reflected only after a delay (eventual consistency)**

```jsonc
const { since } = iris_act({ ref: addBtn, action: "click" })
iris_assert({ predicate: { kind: "net", urlContains: "/api/items", status: 202, since } })       // accepted
iris_assert({ predicate: { kind: "element", query: { text: name, scope: "[data-testid=item-list]" }, absent: true } }) // not yet
// …click Refresh later…
iris_wait_for({ timeout_ms: 3000, predicate: { kind: "element", query: { text: name, scope: "[data-testid=item-list]" }, state: "visible" } })
```

**Click in one section → element appears in another**: act in section A, then `iris_assert`
the element in section B (switch tabs/route first if needed).

**Broken endpoint surfaced**: `{ kind: "net", urlContains: "/x", status: 500 }` or
`{ kind: "console", level: "error" }` for parse/CORS failures.

**Real LLM call → result rendered**:

```jsonc
{
  "allOf": [
    { "kind": "net", "method": "POST", "urlContains": "/api/generate-script", "status": 200 },
    { "kind": "element", "query": { "testid": "script-output" }, "state": "visible" },
  ],
}
```

**Hover changes color**: `iris_inspect(ref).styles.backgroundColor` before vs after
`iris_act({ ref, action: "hover" })`.

**File → modal with score**:

```jsonc
iris_act({ ref: fileInput, action: "upload", args: { name: "pitch.mp4", type: "video/mp4" } })
const { since } = iris_act({ ref: analyzeBtn, action: "click" })
iris_assert({ timeout_ms: 8000, predicate: { allOf: [
  { kind: "net", method: "POST", urlContains: "/api/score", status: 200, since },
  { kind: "element", query: { role: "dialog", name: "Score result" }, state: "visible" },
  { kind: "text", contains: "/ 100", visible: true } ]}})
```

---

## 7. From your test cases → agent checks

Most teams already have **test cases** — a QA checklist, a Notion table, acceptance
criteria, or manual steps QA runs by hand. Iris lets your agent **run those cases against
the live app and verify them with evidence**. A test case translates almost 1:1 into a
predicate:

| Your test case (English)                        | Iris predicate                                                 |
| ----------------------------------------------- | -------------------------------------------------------------- |
| "Login with valid creds lands on the dashboard" | `allOf: [net /api/login 200, element tab "Dashboard" visible]` |
| "Submitting the form shows a success toast"     | `text "Saved" visible` (+ `net … 200`)                         |
| "Deleting an item removes it from the list"     | `element {text, scope:list}` `absent: true`                    |
| "No console errors on the checkout page"        | `console level:error absent:true`                              |
| "Export button is present for admins"           | `element {role:button, name:Export} visible`                   |

This is the sweet spot: the **manual cases you never automated** (the "I just eyeball it"
checks) become things the agent runs _while it codes_, in your real dev session, in seconds.
It complements — doesn't replace — your committed Playwright/Cypress E2E suite: use those for
CI gating, use Iris for in-loop verification and for the long tail of cases nobody wrote
automation for.

---

## 8. Token discipline (keep it cheap)

Iris is designed to be far cheaper than dumping a full tree every step (see
[token-efficiency.md](token-efficiency.md)). Rules of thumb:

- Prefer **`iris_query` + `iris_assert`** (~30 tokens each) over snapshots in the loop.
- Use **`mode: "interactive"`** (only actionable elements) or **`"status"`** (route/dialogs/
  counters) instead of `"full"`.
- Use **`scope`** to snapshot/search just the relevant subtree.
- Reach for `mode: "full"` only when you genuinely need the whole page.

---

## 9. Gotchas & tips

- **Accessibility = legibility.** Real `role`s, labels, and `data-testid`s make queries
  precise. Div-soup works worse — adding test-ids is a small, one-time investment (and
  improves real a11y).
- **Async UIs:** use `timeout_ms` on `assert`/`wait_for`; use the `since` cursor from `act`
  so `observe`/`assert` only consider what happened _after_ the action.
- **Disambiguate:** with many similar controls, prefer stable `data-testid`s over names that
  include dynamic counts (e.g. "Notifications (3)").
- **React 19 source files** need `@iris/babel-plugin` (see §2c).
- **Non-DOM/visual:** `<canvas>`, cross-origin iframes, closed shadow DOM, and pure CSS
  `:hover` styling aren't directly observable — surface state via `iris.signal()` / use a
  JS-driven state for hover; aesthetic "feel" stays a human judgment.
- **Dev only, localhost only** by default. The SDK is additive and reversible — it never
  breaks the host app.

---

## 10. Troubleshooting

- _"no browser session connected"_ → the app isn't running with `@iris/browser` enabled, or
  it's pointed at the wrong bridge URL/port.
- _Element not found_ → check role/name with `iris_snapshot({mode:"interactive"})`; add a
  `data-testid`; widen with `scope`.
- _Assert flakes_ → add/raise `timeout_ms`; ensure you pass `since` from the triggering act.
- _Source file missing on React 19_ → wire `@iris/babel-plugin` into the dev build.
