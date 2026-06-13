<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://cdn.jsdelivr.net/gh/syrin-labs/iris@main/assets/readme/lockup-on-dark.png" />
  <img alt="Syrin Iris — eyes for your coding agent" src="https://cdn.jsdelivr.net/gh/syrin-labs/iris@main/assets/readme/lockup-on-light.png" width="300" />
</picture>

### Your AI writes the code. Iris tells it whether the code actually works — with evidence, not screenshots.

<a href="https://syrin.ai/iris"><img src="https://cdn.jsdelivr.net/gh/syrin-labs/iris@main/assets/readme/hero.gif" alt="Iris catches a 401 your agent said was 'done' — pass:false, with evidence, then a one-line fix to pass:true" width="820" /></a>

[![npm](https://img.shields.io/npm/v/@syrin/iris?color=8b7bff&labelColor=15131f&logo=npm)](https://www.npmjs.com/package/@syrin/iris)
[![downloads](https://img.shields.io/npm/dm/@syrin/iris?color=5fd9f5&labelColor=15131f)](https://www.npmjs.com/package/@syrin/iris)
[![license](https://img.shields.io/badge/license-MIT-46d6a0?labelColor=15131f)](LICENSE)
[![types](https://img.shields.io/npm/types/@syrin/iris?color=ff9f87&labelColor=15131f)](https://www.npmjs.com/package/@syrin/iris)

Iris gives your coding agent a **verdict, not just a view**. The moment your agent finishes a change,
Iris verifies — from **inside your real running app** — that the right things actually happened: the API
call fired with a `200`, the modal opened, the route changed, **no console error slipped in**, the webhook
arrived. If something silently broke, Iris says **what**, **why**, and (on React) the **file:line** to fix.

**TypeScript · Model Context Protocol · React-first · dev-only · localhost-only · MIT**

[Quickstart](#quickstart) · [Watch the demo](https://syrin.ai/iris) · [Getting Started](docs/getting-started.md) · [Full Guide](docs/usage.md) · [Why it's ~73× cheaper](docs/token-efficiency.md) · [How is this different?](#how-is-this-different)

</div>

---

## The problem: your agent has hands, but no eyes

You ask your AI agent to build a feature. It edits the files, says _"done ✅"_ — and then **you** open the
browser, click around, and find out it isn't. Every. Single. Time. The agent can't really check its own
work, so you become its QA department.

- **It can't tell "compiles" from "works."** The code type-checks and the page renders, so the agent
  declares victory — while the Pay button silently `500`s and the console is full of errors.
- **Screenshots are bad eyes.** A full-page shot runs **~1,500+ tokens** through a vision model, is slow
  and non-deterministic — and **blind to everything non-visual**: the failed request, the
  console error, the route that didn't change, the webhook that never came.
- **It ships silent regressions.** A plausible-looking change quietly breaks a sibling feature, and
  nobody notices until a user (or your client) does.
- **Manual QA doesn't scale.** Every change means re-clicking the same flows. You are the slowest part
  of your own loop.

> Modern coding agents are _"effectively programming with a blindfold on."_ Iris takes the blindfold off —
> and instead of handing back a blurry photo, it hands back a **verdict with evidence**.

## The idea: your app already knows what happened — let the agent ask

Your running app knows everything that just happened — _in code_. Iris exposes that to your agent over
**MCP** as a tight loop: **look → act → observe → assert.** One call checks many things at once and comes
back with proof:

```jsonc
// The agent clicked "Pay". Did the right things actually happen? One call, ~33 tokens, no screenshot:
iris_assert({
  predicate: { allOf: [
    { kind: "net",     method: "POST", urlContains: "/api/order", status: 200 },
    { kind: "element", query: { role: "dialog", name: "Order confirmed" }, state: "visible" },
    { kind: "signal",  name: "order:saved" },          // the charge actually committed
    { kind: "console", level: "error", absent: true }  // ...and nothing errored
  ]}
})
// → { pass: false, evidence: { net: { status: 500, url: "/api/order" } },
//     failureReason: "POST /api/order returned 500, expected 200",
//     source: { file: "src/checkout/PayButton.tsx", line: 42 } }   ❌ caught before you ever saw it
```

It’s **deterministic** (structured events, not pixels), **cheap** (any model, no vision), and it tells the
agent exactly where to fix the code.

## Turn the test cases you never automated into checks your agent runs on every edit

Every team has a QA checklist, acceptance criteria, and "I just eyeball it" steps that never became
automated tests. **Iris lets your agent run them against the live app while it codes.** A test case maps
almost 1:1 to a check:

| Your test case (plain English)                  | Iris check                                                     |
| ----------------------------------------------- | -------------------------------------------------------------- |
| "Login with valid creds lands on the dashboard" | `net /api/login 200` **and** `element tab "Dashboard" visible` |
| "Deleting an item removes it from the list"     | `element {text, scope: list}` **absent**                       |
| "Submitting shows a success toast"              | `text "Saved" visible`                                         |
| "Paying actually charges the customer"          | `signal "order:saved"` **and** `net /api/charge 200`           |
| "No console errors on checkout"                 | `console level:error absent`                                   |

> Your CI Playwright/Cypress suite gates releases. **Iris is the checklist your agent runs on every
> edit** — including the long tail nobody ever wrote automation for.

## Catch the regressions your agent would silently ship

Snapshot the app's semantic state now; diff it later. _"Did anything quietly go missing?"_ is a tool call,
not a manual hunt:

```jsonc
iris_baseline_save({ name: "dashboard" })   // before the change
// ...agent edits code...
iris_diff({ baseline: "dashboard" })
// → { removed: [ { role: "button", name: "Export" } ], counters: { consoleErrors: +1 } }
//   the agent deleted the Export button and introduced an error — flagged, not shipped.
```

## ~73× fewer tokens than feeding the agent the whole page (and we'll show you the honest math)

Measured on the same dashboard (a 1,000-item list) — [full methodology + caveats](docs/token-efficiency.md):

|                                                        | Tokens per step |
| ------------------------------------------------------ | --------------: |
| Full accessibility-tree snapshot (e.g. Playwright MCP) |          ~7,300 |
| **Iris verify loop** (query + observe + assert)        |        **~100** |

Iris asks _narrow questions_ instead of dumping the whole page every step. A 20-step flow: **~2,000 tokens
with Iris vs ~146,000** with full-tree snapshots — the difference between "too expensive to run" and "run
it on every edit."

> **The honest version** (we'd rather you hear it from us): force Iris to dump the _whole_ tree too and the
> gap is only ~1.8×. The 73× comes from **not needing the whole tree** — that's architectural, not a
> serializer trick. [Read the full breakdown →](docs/token-efficiency.md)

---

## Quickstart

**One install** — SDK, React adapter, source-mapping plugins, spec runner, and the MCP server all ship in
a single package, `@syrin/iris`:

```bash
npm i -D @syrin/iris
```

**1. Point your agent at the MCP server** — Claude Code (`.mcp.json`), Cursor, Windsurf, etc.:

```jsonc
{ "mcpServers": { "iris": { "command": "npx", "args": ["@syrin/iris"] } } }
```

**2. Embed the SDK in your app (dev only)**

```ts
import { iris } from '@syrin/iris';
if (import.meta.env.DEV) iris.connect({ session: 'my-app' });
```

That's it — run your app and ask your agent: _"add a logout button and verify it works with Iris."_ → see
[Getting Started](docs/getting-started.md) for the full walkthrough (React adapter, source mapping via
`@syrin/iris/next` or `/babel`, and adding `signals` at the points that matter).

> Prefer granular installs? Every piece is still its own package — `@syrin/iris-browser`,
> `@syrin/iris-react`, `@syrin/iris-next`, `@syrin/iris-babel-plugin`, `@syrin/iris-server`,
> `@syrin/iris-test`, `@syrin/iris-eslint-plugin`. `@syrin/iris` just re-exports them so you install and
> import **one**.

---

## What it can verify

Six canonical reactions, plus anything your app emits:

- ✅ **API calls** — method, URL, status, timing (`net`)
- ✅ **DOM changes** — element appeared / disappeared, modal/drawer/toast opened
- ✅ **Navigation** — SPA route changes
- ✅ **Console & errors** — including "**no** errors during this flow"
- ✅ **Animations** — started / completed
- ✅ **App signals** — webhooks, websockets, store commits, async jobs you surface via `iris.signal()`
- ✅ **Regressions** — baseline now, diff later ("did anything silently go missing?")
- ✅ **Source mapping** — DOM element → React component → **file:line** to edit

…and an autonomous **crawler** (`iris_crawl`) that clicks every reachable control and classifies what
breaks (console error, failed request, dead control). ~44 MCP tools in total.

## Why screenshots can't do this — and Iris can: `signals`

The most important question is rarely visible. _"Did the charge actually commit?"_ isn't a pixel. So your
app emits structured facts at the moments that matter:

```ts
iris.signal('order:saved', { id: '123', total: 4999 }); // the store committed
iris.signal('webhook:received', { provider: 'stripe' }); // an external event arrived
```

…and the agent asserts on them directly. A bundled ESLint rule (`require-signal-on-mutation`) flags any
state mutation that forgot to emit one, so your observable surface can't silently drift from your code.

## How it works

```text
your coding agent ──MCP──▶ iris bridge + server ──WebSocket──▶ @syrin/iris-browser (in your app)
                                   ▲                                    │
                                   └──────────── observations ─────────┘
                          (DOM · network · routes · console · animations · signals)
```

Your app instruments _itself_ with a tiny dev-only SDK (7 observers feeding a 2,000-event / 60s ring
buffer). The bridge relays the agent's MCP tool calls to the page and streams the page's observations back.
Nothing leaves your machine; it's **localhost-only** and **tree-shaken out of production**.

---

## How is this different?

The category is crowded — here's the honest map. The short version: **everyone now gives agents _eyes_;
Iris gives agents a _verdict_.**

|                                          | What it's for                                                                                                                                                                                                      |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Playwright / Cypress**                 | Scripted E2E tests in CI. Great — but you write and maintain them, and they run separately from your agent.                                                                                                        |
| **Playwright MCP / Chrome DevTools MCP** | Let an agent _drive/inspect_ a separate browser. Powerful — but full-tree snapshots are token-heavy, they leave "did it work?" for the agent to infer, and there's no first-class assert/regression or source-map. |
| **Domscribe / React Grab / LocatorJS**   | Map a DOM element to its source file:line (Iris does this too). But they stop at editing — **no assertions, no regression, no network/console/signal observation.**                                                |
| **Iris**                                 | Lets your agent _verify_ your running app cheaply, from **inside** it (your real session/auth), with **assertions + regression + signals** as first-class — and points at the **source file** to fix.              |

**They compose:** drive with Playwright MCP, **verify with Iris.**

<details>
<summary><b>“Why not just use Playwright MCP / Chrome DevTools MCP? They’re free and official.”</b></summary>

They’re built to **drive** a browser, not to **verify** an app. They hand your agent a full
accessibility-tree snapshot (~6.8k tokens, up to 50k on big pages) and the agent has to _infer_ whether
things worked; they’re blind to non-visual events (the webhook, the store commit); they spin up a
_separate_ browser; they have no regression/baseline primitive; and they can’t tell the agent _which file_
to fix. Iris runs _inside_ your real app, returns a verdict-with-evidence in ~100 tokens, sees what
screenshots can’t, catches silent regressions, and source-maps to file:line. **Drive with theirs; verify
with Iris.**

</details>

<details>
<summary><b>“Can’t the agent just take a screenshot?”</b></summary>

It can — and it’s the worst option: a full-page screenshot runs ~1,500+ tokens through a vision model,
is non-deterministic, and is blind to everything non-visual. Iris answers those as ~33-token structured
predicates. (Iris _also_ ships `iris_screenshot` / `iris_visual_diff` for the genuinely visual checks.)

</details>

<details>
<summary><b>“How efficient / reliable is it, really?”</b></summary>

~100 tokens for a full verify loop vs ~7,300 for a full-tree snapshot — ~73× on the common loop (honest
caveat: ~1.8× full-tree-vs-full-tree). Deterministic: it reads structured events from a ring buffer with
look-back + await-forward semantics, no vision model involved; `iris_clock` can freeze/advance time for
toasts and debounces. Backed by 95 test files. [Methodology →](docs/token-efficiency.md)

</details>

<details>
<summary><b>“How much work is integration?”</b></summary>

Two lines to start (`iris.connect()` + point your agent at the MCP server); reuse existing testids
immediately. Depth is incremental — add `signals` only at the commit points that matter (a lint rule flags
the ones you miss). Dev-only, tree-shaken out of production.

</details>

## Docs

- **[Getting Started](docs/getting-started.md)** — install, wire up your agent, first verification (step by step).
- **[Integrate with Claude Code](docs/integrate-with-claude-code.md)** — copy-paste prompts to make a coding agent wire Iris in and verify its own work.
- **[Integration Patterns](docs/integration-patterns.md)** — zero-prod-bundle integration + adopting Iris incrementally (testids → capabilities → signals).
- **[Usage Guide](docs/usage.md)** — every tool, the predicate DSL, real situations & use cases, FAQ.
- **[Flows, recorder & self-healing](docs/flows.md)** — record once / run forever: `.iris/` flows anchored on testid+signal, legible drift, `iris_flow_heal`.
- **[Testing with `@syrin/iris-test`](docs/testing.md)** — declarative, signal-bound specs (`irisTest`), headless runs, flows-as-specs, CI.
- **[Human-in-the-loop control](docs/human-control.md)** — pause/steer/end the agent from the floating panel.
- **[Token Efficiency](docs/token-efficiency.md)** — the head-to-head benchmark + honest methodology.
- **[Use it in your own app (no npm publish)](docs/local-install.md)** — local-registry path for testing in a real external app today.

## Packages

| Package                                               | Role                                                   |
| ----------------------------------------------------- | ------------------------------------------------------ |
| [`@syrin/iris`](packages/iris)                        | **One-install umbrella** — re-exports everything below |
| [`@syrin/iris-browser`](packages/browser)             | The SDK you embed in your app (DOM-side)               |
| [`@syrin/iris-server`](packages/server)               | Bridge + MCP server (the `iris` CLI)                   |
| [`@syrin/iris-react`](packages/react)                 | React adapter: DOM → component → source file           |
| [`@syrin/iris-babel-plugin`](packages/babel-plugin)   | Source mapping on React 19 (`data-iris-source`)        |
| [`@syrin/iris-next`](packages/next)                   | Next.js source mapping (keeps SWC) via `withIris`      |
| [`@syrin/iris-test`](packages/test)                   | Declarative spec runner (`irisTest`)                   |
| [`@syrin/iris-eslint-plugin`](packages/eslint-plugin) | `require-signal-on-mutation` lint rule                 |
| [`@syrin/iris-protocol`](packages/protocol)           | Shared wire contract (types + zod schemas)             |

## Status & safety

Active development (v0.3.x); **dev-only and localhost-only by default**. Observers are additive and fully
reversible — Iris never breaks the host app. No telemetry. MIT licensed. React 18/19 + Next.js today; the
core SDK and `signals` are framework-agnostic (Vue/Svelte adapters on the roadmap).

See [`WELCOME.md`](WELCOME.md) to develop.

## License

MIT © Iris contributors
