# IRIS.md — Single-Source Context Pack

> **Purpose:** hand this one file to any coding agent, copywriter, or design agent and it has everything
> needed to build the landing page (iris.syrin.ai / syrin.ai/iris), write copy, pitch investors, or extend
> the product — without re-reading the codebase. Everything here is **verified against the repo (v0.3.10)**
> or sourced from 2025–2026 market research. Deeper detail lives in `plan/market/*` and `docs/*`.
>
> **Accuracy rule for anyone using this file:** never inflate. Verified numbers only (below). A skeptic who
> catches one wrong number distrusts all of them — and this audience checks.

---

## 1. What Iris is (the elevator version)

Iris gives an AI coding agent a **verdict, not just a view** of a running web app. Drop a tiny dev-only SDK
into your app, point your agent at the Iris MCP server, and the agent can verify — _from inside your real,
authenticated app_ — that the code it just wrote actually works: the API call fired with the right status,
the modal opened, the route changed, no console error slipped in, the webhook arrived. If something silently
broke, Iris reports **what**, **why**, and (on React) the **file:line** to fix — deterministically, with no
screenshot, in ~100 tokens.

- **Org:** Syrin Labs · **Product:** Iris · **Landing:** `iris.syrin.ai` (primary), `syrin.ai/iris`
- **Tech:** TypeScript monorepo (pnpm + turbo), Model Context Protocol, React-first, dev-only, localhost-only, MIT
- **Tagline options:** "Your AI writes the code. Iris checks it actually works." / "Eyes see. Iris verifies." / "A verdict, not a view."

## 2. The pain (validated)

AI coding agents have "hands but no eyes" — they write code but can't verify it in a running app, so the
human becomes the QA loop. The agent can't tell "compiles" from "works," ships silent regressions, and
screenshots are expensive (a full-page shot can exceed 200k tokens), slow, need a vision model, and are
blind to non-visual events (failed requests, console errors, webhooks, store commits).

**Validation:** ~90% of devs use an AI coding tool (JetBrains 2026); Google shipped Chrome DevTools MCP with
the tagline "give your AI eyes" and Microsoft ships Playwright MCP — both validating the exact thesis.
Independent devs describe it identically: "hands but no eyes," "programming with a blindfold on," "you feel
gaslighted by your own agent." (Sources in `plan/market/01-market-validation.md`.)

## 3. Positioning — what to LEAD with (critical)

The "give agents eyes" layer is **commoditized and free** (Google/Microsoft). So:

- ✅ **LEAD with:** _verdict not view_ · _catch silent regressions_ · _see what screenshots can't (signals)_ · _deterministic, evidence-based verification in the dev loop_.
- ⚠️ **Use as PROOF, not headline (table stakes by 2026):** "fewer tokens," "give your AI eyes," "no screenshots."
- ❌ **NOT differentiators (say so honestly):** "see the running app" (Google, free), "run in real authed session" (Playwright MCP extension + Chrome DevTools CDP-attach reach it too), "DOM→component→file:line" (Domscribe/React Grab/LocatorJS do it).

**One-liner:** _Iris gives your coding agent a verdict, not just a view — it verifies, with evidence from
inside your real running app, that the code it just wrote works, and flags anything it silently broke._

**Strategic takeaway:** _Everyone now gives agents eyes. Almost no one gives agents a verdict._ That verdict
— with evidence, regression-aware, from inside the real app — is the wedge.

## 4. The four message pillars (priority order)

1. **Verdict, not view.** `iris_assert` → `{ pass, evidence }`; one call checks many conditions; on fail it says why + file:line. Free tools hand a snapshot and make the agent guess.
2. **Catches silent regressions.** `baseline_save` → `diff`: "did anything quietly go missing?" The pain that survives commoditization.
3. **Sees what screenshots can't.** `signals` — webhooks, store commits, async jobs, websocket events. The real question ("did the charge actually commit?") isn't a pixel.
4. **Cheap enough for every edit.** ~100 tokens/loop vs ~7,300 full-tree snapshot, deterministic, any model, no vision.

## 5. How it works (architecture)

```
your coding agent ──MCP──▶ iris bridge + server ──WebSocket──▶ @syrin/iris-browser (SDK in your app)
                                  ▲                                    │
                                  └──────────── observations ─────────┘
                         (DOM · network · routes · console · animations · signals)
```

The app instruments **itself** with a dev-only SDK: **7 observers** (DOM, network, route, console,
animation, scroll, health) feed a **2,000-event / 60s ring buffer** with `since` cursors and look-back +
await-forward semantics (so verification is deterministic). The bridge relays MCP tool calls to the page and
streams observations back. Localhost-only; tree-shaken out of production; no telemetry.

**The loop:** `look` (snapshot/query/inspect) → `act` (click/fill/…) → `observe` (timeline of what happened)
→ `assert` (predicate → verdict + evidence).

**Source mapping (DOM → component → file:line):** React fiber walk (`@syrin/iris-react`) for React 18;
Babel plugin stamps `data-iris-source` for React 19 (`@syrin/iris-babel-plugin`); a webpack pre-loader
preserves SWC for Next.js (`@syrin/iris-next` `withIris`).

**Signals:** `iris.signal('order:saved', {...})` emits app facts the DOM can't show; ESLint rule
`require-signal-on-mutation` prevents drift.

## 6. Verified facts & numbers (SAFE to publish)

| Fact                                            | Value                                                                                                                                                                                                                                           |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Version                                         | **v0.3.10**, all `@syrin/*` packages on npm                                                                                                                                                                                                     |
| MCP tools                                       | **~44** (`iris_assert`, `iris_observe`, `iris_query`, `iris_snapshot`, `iris_act`, `iris_diff`, `iris_baseline_save`, `iris_crawl`, `iris_inspect`, `iris_state`, `iris_capabilities`, `iris_flow_*`, `iris_screenshot`, `iris_visual_diff`, …) |
| Observers                                       | **7** (DOM, network, route, console, animation, scroll, health)                                                                                                                                                                                 |
| Ring buffer                                     | 2,000 events / 60s window                                                                                                                                                                                                                       |
| Tests                                           | **95 test files / ~12,500 lines**                                                                                                                                                                                                               |
| Token: full verify loop                         | **~100 tokens**                                                                                                                                                                                                                                 |
| Token: full a11y-tree snapshot (Playwright MCP) | **~7,300 tokens**                                                                                                                                                                                                                               |
| Headline ratio                                  | **~73×** on the common loop (100–500× on complex pages)                                                                                                                                                                                         |
| Honest caveat                                   | full-tree vs full-tree only **~1.8×** (4,144 vs 7,300) — savings are architectural, not a serializer trick                                                                                                                                      |
| 20-step flow                                    | **~2,000 tokens (Iris)** vs **~146,000 (full-tree)**                                                                                                                                                                                            |
| Single assert                                   | **~33 tokens**, no screenshot, no vision model, deterministic                                                                                                                                                                                   |
| Benchmark repro                                 | `node plan/vs-playwright.mjs` (demo + api running); see `docs/token-efficiency.md`                                                                                                                                                              |
| Frameworks                                      | React 18/19 + Next.js today; SDK + signals framework-agnostic; Vue/Svelte on roadmap                                                                                                                                                            |
| Safety                                          | dev-only, localhost-only by default, no telemetry, MIT, tree-shaken out of prod                                                                                                                                                                 |

**DO NOT publish** (earlier drafts guessed these wrong): "57 tools," "235 test files," "39k lines." Real =
~44 tools, 95 test files, ~12.5k lines.

**DO NOT fabricate:** any "% fewer bugs," "saves N hours," catch-rate-vs-competitors, or user/adoption counts
— no data exists yet (see `plan/market/06-benchmarks-and-proof.md` for what to build).

## 7. What it can verify

API calls (method/URL/status/timing) · DOM changes (appeared/disappeared, modal/toast/drawer) · SPA
navigation · console & errors (incl. "no errors during this flow") · animations (started/completed) · app
signals (webhooks/websockets/store commits/async jobs) · regressions (baseline → diff) · source mapping
(element → component → file:line) · autonomous crawl (clicks every control, classifies failures).

## 8. The aha code example (use in copy/demos)

```jsonc
// Agent clicked "Pay". One call, ~33 tokens, no screenshot:
iris_assert({ predicate: { allOf: [
  { kind: "net", method: "POST", urlContains: "/api/order", status: 200 },
  { kind: "element", query: { role: "dialog", name: "Order confirmed" }, state: "visible" },
  { kind: "signal", name: "order:saved" },
  { kind: "console", level: "error", absent: true }
]}})
// → { pass: false, evidence: { net: { status: 500 } },
//     failureReason: "POST /api/order returned 500, expected 200",
//     source: { file: "src/checkout/PayButton.tsx", line: 42 } }
```

## 9. Quickstart (for landing "how it works")

```bash
npm i -D @syrin/iris
```

```jsonc
// .mcp.json (Claude Code / Cursor / Windsurf)
{ "mcpServers": { "iris": { "command": "npx", "args": ["@syrin/iris"] } } }
```

```ts
import { iris } from '@syrin/iris';
if (import.meta.env.DEV) iris.connect({ session: 'my-app' });
```

Then: _"add a logout button and verify it works with Iris."_

## 10. Packages

`@syrin/iris` (umbrella) · `@syrin/iris-browser` (SDK) · `@syrin/iris-server` (bridge + MCP + CLI) ·
`@syrin/iris-react` (React adapter) · `@syrin/iris-babel-plugin` (React 19 source map) · `@syrin/iris-next`
(Next.js, keeps SWC) · `@syrin/iris-test` (spec runner) · `@syrin/iris-eslint-plugin` (signal lint) ·
`@syrin/iris-protocol` (wire contract).

## 11. Competitive one-liners (for comparison sections)

- **Playwright / Cypress:** scripted E2E you write & maintain in CI; runs separately from your agent. _Iris composes — it's the in-loop checklist for the long tail._
- **Playwright MCP (MS, ~33k★) / Chrome DevTools MCP (Google, ~43k★):** drive/inspect a _separate_ browser; token-heavy full-tree snapshots; leave "did it work?" to the agent; no first-class assert/regression/source-map. _Drive with them, verify with Iris._
- **Domscribe / React Grab / LocatorJS:** map DOM→file:line (Iris does too) but stop at editing — no assert, no regression, no network/console/signal.
- **browser-use / Stagehand:** autonomous task agents / cloud automation — different category (do tasks vs verify your code).

**The killer objection + answer:** _"Why not just Playwright MCP / Chrome DevTools MCP (free, official)?"_ →
They give _eyes_ (a snapshot the agent must interpret, ~6.8k tokens, blind to non-visual events, separate
browser, no regression, no file:line). Iris gives a _verdict_ (evidence in ~100 tokens, sees signals,
catches regressions, points at the file). Use both — drive with theirs, verify with Iris.

## 12. Brand & tone (for copywriters)

- **Audience:** developers who use AI coding agents (Claude Code, Cursor, Windsurf) on React/Next apps —
  from indie/vibe-coders to small teams & agencies.
- **Tone:** technical, confident, _self-critical_. This audience punishes hype. **Banned words:**
  "revolutionary," "game-changing," "10x," "seamless," "effortless." **Required:** reproducible numbers,
  volunteered caveats, fair naming of competitors, concrete over abstract.
- **Trust devices:** publish the honest token caveat; link reproducible benchmarks; "Playwright MCP is
  excellent and Microsoft-backed" _then_ differentiate; show one clip where something obviously useful
  happens (the regression catch).
- **Audience hooks:** indie → "Stop being your AI's QA." · teams → "The QA checklist you never automated,
  run on every edit." · agencies → "Catch the silent breakage before the client does." · leaders →
  "Deterministic, token-cheap verification in the dev loop; composes with your CI."

## 13. Hero demo (the asset everything points at)

60–90s screen recording: agent adds a feature → runs Iris verify loop → Iris catches a _silent regression_
(a sibling API 500s) a screenshot/snapshot agent would ship → reports the failing `net` evidence + file:line
→ agent fixes → green. On-screen: "~100 tokens/check, no screenshot." Cut to 15s (IG/X), 40s
(Reddit/LinkedIn), 90s (YouTube/docs).

## 14. Where to find more

- `plan/market/00-executive-summary.md` — the verdict + 30-day plan
- `plan/market/01-market-validation.md` — pain evidence + honest counter-case + sources
- `plan/market/02-competitive-landscape.md` — full competitor map
- `plan/market/03-positioning-and-messaging.md` — message architecture, audience angles
- `plan/market/04-go-to-market.md` — Reddit/X/LinkedIn/IG playbooks + validation experiments + 30-day sequence
- `plan/market/05-faq-objections-investors.md` — every hard question, answered
- `plan/market/06-benchmarks-and-proof.md` — what's verified vs what to build
- `docs/*` — product docs (getting-started, usage, token-efficiency, flows, testing, human-control)
- `README.md` — public face · `CLAUDE.md` — engineering rules · `plan/` — design docs (gitignored)
