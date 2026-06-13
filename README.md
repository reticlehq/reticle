<div align="center">

# Iris 👁️

### Your AI writes the code. Iris checks that it actually works — without screenshots.

Iris gives your coding agent **eyes** into your running web app. Instead of taking
screenshots and guessing, the agent reads what your app _actually did_ — the API call that
fired, the modal that opened, the console error it threw, the element that appeared — and
**verifies it with evidence**.

**TypeScript · Model Context Protocol · React-first · dev-only · localhost-only**

[Quickstart](#quickstart) · [Getting Started](docs/getting-started.md) · [Full Guide](docs/usage.md) · [Why it's ~69× cheaper](docs/token-efficiency.md)

</div>

---

## The problem

You ask your AI agent to build a feature. Then _you_ open the browser, click around, and
check it actually works — every time. The agent can't really check its own work:

- **Screenshots are bad eyes.** They're expensive (1–2k+ tokens each), need a vision model,
  and are blind to everything non-visual — the network call, the console error, the route
  change.
- **Manual QA doesn't scale.** Every change means re-clicking the same flows. Something
  silently breaks and nobody notices until production.

## The idea

Your app already knows everything that happened — _in code_. Iris exposes that to your agent
over MCP, so it can **look → act → observe → assert**:

```jsonc
// The agent clicked "Pay". Did the right things actually happen? One call:
iris_assert({
  predicate: { allOf: [
    { kind: "net",     method: "POST", urlContains: "/api/order", status: 200 },
    { kind: "element", query: { role: "dialog", name: "Order confirmed" }, state: "visible" },
    { kind: "console", level: "error", absent: true }
  ]}
})
// → { pass: true, evidence: { … } }   ✅ deterministic, no screenshot, ~33 tokens
```

If it fails, Iris says _why_ — the near-miss, the console error, and (on React) the **source
file to fix**.

## Turn your test cases into agent checks

Every team has test cases they never automated — the QA checklist, the acceptance criteria,
the "I just eyeball it" steps. **Iris lets your agent run them against the live app, while it
codes.** A test case maps almost 1:1 to a check:

| Your test case (plain English)                  | Iris check                                                     |
| ----------------------------------------------- | -------------------------------------------------------------- |
| "Login with valid creds lands on the dashboard" | `net /api/login 200` **and** `element tab "Dashboard" visible` |
| "Deleting an item removes it from the list"     | `element {text, scope: list}` **absent**                       |
| "Submitting shows a success toast"              | `text "Saved" visible`                                         |
| "No console errors on checkout"                 | `console level:error absent`                                   |

> Your CI Playwright/Cypress suite gates releases. **Iris is the checklist your agent runs on
> every edit** — including the long tail nobody wrote automation for.

## ~69× fewer tokens than feeding the agent a full page

Measured on the same dashboard (a 1,000-item list), [full methodology](docs/token-efficiency.md):

|                                                        | Tokens per step |
| ------------------------------------------------------ | --------------: |
| Full accessibility-tree snapshot (e.g. Playwright MCP) |          ~6,856 |
| **Iris verify loop** (query + observe + assert)        |        **~100** |

Iris asks _narrow questions_ instead of dumping the whole page every step. A 20-step flow:
~2,000 tokens with Iris vs ~138,000 with full-tree snapshots — the difference between "too
expensive to run" and "run it on every edit."

---

## Quickstart

**1. Run the bridge + MCP server**

```bash
npx @iris/server          # ws://localhost:4400, speaks MCP over stdio
```

**2. Point your agent at it** — Claude Code (`.mcp.json`), Cursor, Windsurf, etc.:

```jsonc
{ "mcpServers": { "iris": { "command": "npx", "args": ["@iris/server"] } } }
```

**3. Embed the SDK in your app (dev only)**

```bash
npm i -D @iris/browser
```

```ts
import { iris } from '@iris/browser';
if (import.meta.env.DEV) iris.connect({ session: 'my-app' });
```

That's it — run your app, and ask your agent: _"add a logout button and verify it works with
Iris."_ → see [Getting Started](docs/getting-started.md) for the full walkthrough (React
adapter, source mapping, examples).

---

## What it can verify

The six canonical reactions, plus anything your app emits:

- ✅ **API calls** — method, URL, status, timing (`net`)
- ✅ **DOM changes** — element appeared / disappeared, modal/drawer/toast opened
- ✅ **Navigation** — SPA route changes
- ✅ **Console & errors** — including "**no** errors during this flow"
- ✅ **Animations** — started / completed
- ✅ **App signals** — webhooks, websockets, store changes you surface via `iris.signal()`
- ✅ **Regressions** — baseline now, diff later ("did anything silently go missing?")
- ✅ **Source mapping** — DOM element → React component → **file:line** to edit

## How it works

```text
your coding agent ──MCP──▶ iris bridge + server ──WebSocket──▶ @iris/browser (in your app)
                                   ▲                                    │
                                   └──────────── observations ─────────┘
                          (DOM · network · routes · console · animations · signals)
```

Your app instruments _itself_ (a tiny dev-only SDK). The bridge relays the agent's
MCP tool calls to the page and streams the page's observations back. Nothing leaves your
machine; it's localhost-only and tree-shaken out of production.

## Packages

| Package                                       | Role                                            |
| --------------------------------------------- | ----------------------------------------------- |
| [`@iris/browser`](packages/browser)           | The SDK you embed in your app (DOM-side)        |
| [`@iris/server`](packages/server)             | Bridge + MCP server (the `iris` CLI)            |
| [`@iris/react`](packages/react)               | React adapter: DOM → component → source file    |
| [`@iris/babel-plugin`](packages/babel-plugin) | Source mapping on React 19 (`data-iris-source`) |
| [`@iris/protocol`](packages/protocol)         | Shared wire contract (types + zod schemas)      |

## Docs

- **[Getting Started](docs/getting-started.md)** — install, wire up your agent, first verification (step by step).
- **[Usage Guide](docs/usage.md)** — every tool, the predicate DSL, real situations & use cases, FAQ.
- **[Token Efficiency](docs/token-efficiency.md)** — the head-to-head benchmark + methodology.

## How is this different?

|                                          | What it's for                                                                                                                                                                               |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Playwright / Cypress**                 | Scripted E2E tests in CI. Great — but you write and maintain them, and they run separately from your agent.                                                                                 |
| **Playwright MCP / Chrome DevTools MCP** | Let an agent _drive/inspect_ a browser. Powerful, but full-tree snapshots are token-heavy and they spin up a separate browser.                                                              |
| **Iris**                                 | Lets your agent _verify_ your running app cheaply, from **inside** it (your real session/auth), with **assertions + regression** as first-class — and points at the **source file** to fix. |

They compose: drive with one, assert with Iris.

## Status & safety

Active development; **dev-only and localhost-only by default**. Observers are additive and
fully reversible — Iris never breaks the host app. No telemetry. MIT licensed.

See [`WELCOME.md`](WELCOME.md) to develop.

## License

MIT © Iris contributors
