<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://cdn.jsdelivr.net/gh/reticlehq/reticle@main/assets/readme/lockup-on-dark.png" />
  <img alt="Reticle — the proof layer for AI agents" src="https://cdn.jsdelivr.net/gh/reticlehq/reticle@main/assets/readme/lockup-on-light.png" width="300" />
</picture>

### Your AI writes the code. Reticle tells it whether the code actually works — with evidence, not screenshots.

<a href="https://github.com/reticlehq/reticle"><img src="https://cdn.jsdelivr.net/gh/reticlehq/reticle@main/assets/readme/hero.gif" alt="Reticle catches a 401 your agent said was 'done' — pass:false with evidence, then a one-line fix to pass:true" width="760" /></a>

[![npm](https://img.shields.io/npm/v/@reticlehq/core?color=8b7bff&labelColor=15131f&logo=npm)](https://www.npmjs.com/package/@reticlehq/core) [![downloads](https://img.shields.io/npm/dm/@reticlehq/core?color=5fd9f5&labelColor=15131f)](https://www.npmjs.com/package/@reticlehq/core) [![license](https://img.shields.io/badge/license-Apache--2.0%20%2B%20FSL-46d6a0?labelColor=15131f)](https://github.com/reticlehq/reticle/blob/main/LICENSE)

**TypeScript · Model Context Protocol · React-first · dev-only · localhost-only · open-core (Apache-2.0 SDK + FSL server)**

[Docs & full README](https://github.com/reticlehq/reticle) · [Getting Started](https://github.com/reticlehq/reticle/blob/main/docs/getting-started.md) · [Why it's ~73× cheaper](https://github.com/reticlehq/reticle/blob/main/docs/token-efficiency.md)

</div>

---

## The problem: your agent has hands, but no eyes

You ask your AI agent to build a feature. It edits the files, says _"done ✅"_ — and then **you** open the browser, click around, and find out it isn't. Every. Single. Time. The agent can't really check its own work, so you become its QA department. Screenshots are bad eyes: ~1,500+ tokens through a vision model, slow, non-deterministic, and **blind to everything non-visual** — the failed request, the console error, the route that didn't change, the webhook that never came.

## The idea: your app already knows what happened — let the agent ask

Reticle exposes your running app to your agent over **MCP** as a tight loop — **look → act → observe → assert** — and one call checks many things at once and comes back with proof:

```jsonc
// The agent clicked "Pay". Did the right things actually happen? One call, ~33 tokens, no screenshot:
reticle_assert({
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

Deterministic (structured events, not pixels), cheap (any model, no vision), and it points at the **file:line** to fix.

## Quickstart

**One install** — SDK, React adapter, source-mapping plugins, spec runner, and the MCP server all ship in a single package:

```bash
npm i -D @reticlehq/core
```

**1. Point your agent at the MCP server** (Claude Code `.mcp.json`, Cursor, Windsurf, …):

```jsonc
{ "mcpServers": { "reticle": { "command": "npx", "args": ["@reticlehq/core"] } } }
```

**2. Embed the SDK in your app (dev only):**

```ts
import { reticle } from '@reticlehq/core';
if (import.meta.env.DEV) reticle.connect({ session: 'my-app' });
```

Run your app and ask your agent: _"add a logout button and verify it works with Reticle."_ → [Full Getting Started walkthrough](https://github.com/reticlehq/reticle/blob/main/docs/getting-started.md).

## What it can verify

API calls (`net`) · DOM changes · SPA navigation · console & errors (incl. "**no** errors") · animations · app **signals** (webhooks, store commits, async jobs you surface via `reticle.signal()`) · **regressions** (baseline now, diff later) · **source mapping** (DOM → React component → file:line). Plus an autonomous crawler. ~44 MCP tools in total.

## ~73× fewer tokens than feeding the agent the whole page

|                                                        | Tokens per step |
| ------------------------------------------------------ | --------------: |
| Full accessibility-tree snapshot (e.g. Playwright MCP) |          ~7,300 |
| **Reticle verify loop** (query + observe + assert)     |        **~100** |

The honest version: force Reticle to dump the whole tree too and the gap is only ~1.8×. The 73× comes from **not needing the whole tree** — that's architectural. [Full methodology + caveats →](https://github.com/reticlehq/reticle/blob/main/docs/token-efficiency.md)

## Benchmarked two ways — a toy app and a real one — both published

<img src="https://cdn.jsdelivr.net/gh/reticlehq/reticle@main/assets/readme/bench-two-apps.png" alt="On a controlled app Reticle has the highest Verification Efficiency (12.3 vs 10.6 vs 7.0); on a real production dashboard Reticle is the cheapest to observe (1,023 vs 1,357 vs 2,193 tokens)" width="820" />

On a real production app (the [Reticle](https://reticle.ai) dashboard — React 19, auth, live data), Reticle observed the authenticated app for **1,023 tokens vs Chrome DevTools MCP 1,357 vs Playwright MCP 2,193 (2.1× leaner)** — and was the **only** tool that could assert login actually succeeded from the app's own signal (46 tok, un-fakeable) and read program state the DOM never shows. On the first uninstrumented pass it even caught two live `500`s the page completely hid (a missing DB migration). Full honest breakdown, including where Reticle **loses** (true pixels, sites you don't own): [`docs/benchmarks.md`](https://github.com/reticlehq/reticle/blob/main/docs/benchmarks.md).

## How is this different?

Everyone now gives agents _eyes_; **Reticle gives agents a _verdict_.** Playwright/Cypress are scripted CI tests you write and maintain. Playwright MCP / Chrome DevTools MCP let an agent _drive_ a separate browser (token-heavy snapshots, no first-class assert/regression/source-map). Reticle runs _inside_ your real running app (your session/auth), returns a verdict-with-evidence in ~100 tokens, sees what screenshots can't, catches silent regressions, and points at the file to fix. **They compose: drive with Playwright MCP, verify with Reticle.**

---

dev-only and localhost-only by default · no telemetry · tree-shaken out of production · open-core (Apache-2.0 SDK + FSL server)

**[→ Full documentation on GitHub](https://github.com/reticlehq/reticle)**
