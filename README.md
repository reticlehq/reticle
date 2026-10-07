<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/readme/lockup-on-dark.png" />
  <img alt="Reticle" src="assets/readme/lockup-on-light.png" width="240" />
</picture>

<br/>

**Your AI agent says "done." Reticle checks whether that's true.**

It drives your real running app, reads what actually happened, and hands back **pass · fail · couldn't tell** with the `file:line` to fix.

<br/>

[![npm](https://img.shields.io/npm/v/@reticlehq/server?color=8b7bff&labelColor=15131f&logo=npm)](https://www.npmjs.com/package/@reticlehq/server) [![downloads](https://img.shields.io/npm/dm/@reticlehq/react?color=5fd9f5&labelColor=15131f)](https://www.npmjs.com/package/@reticlehq/react) [![stars](https://img.shields.io/github/stars/reticlehq/reticle?color=ff9f87&labelColor=15131f&logo=github)](https://github.com/reticlehq/reticle/stargazers) [![license](https://img.shields.io/badge/license-Apache--2.0%20%2B%20FSL-46d6a0?labelColor=15131f)](LICENSE) [![OpenSSF](https://api.securityscorecards.dev/projects/github.com/reticlehq/reticle/badge)](https://securityscorecards.dev/viewer/?uri=github.com/reticlehq/reticle) [![Discord](https://img.shields.io/badge/Discord-join-8b7bff?labelColor=15131f&logo=discord&logoColor=white)](https://discord.gg/BwAbzv9ZRz)

[**Install**](#install) · [**Use it**](#use-it) · [Use cases](#what-people-use-reticle-for) · [How it works](#how-it-works) · [vs Playwright](#why-not-playwright) · [Benchmarks](#benchmarks) · [Safe to install](#built-to-be-safe-to-install) · [Docs](https://docs.reticle.sh)

<br/>

<!-- An animated image, because GitHub strips iframes and no embedded player can autoplay here. Mux
     serves at most 10 seconds as a GIF; the link opens the full video. -->
<a href="https://player.mux.com/ap7hnnu4j36BRV6wEcop1NZVpJTjVSedxpW1AaXdD3I?metadata-video-title=reticle%27s+demo+&video-title=reticle%27s+demo+">
  <img src="https://image.mux.com/ap7hnnu4j36BRV6wEcop1NZVpJTjVSedxpW1AaXdD3I/animated.gif?start=2&end=12&width=640&fps=15" width="640"
       alt="An agent says the invoice fix works; Reticle drives the Pay button, sees the card charged twice, and names PayButton.tsx:31" />
</a>

<sub>▶ An agent says its fix works. Reticle catches the double charge it missed. Click for the full demo.</sub>

</div>

---

## Install

One command. Needs Node 20.11+ (no Node? `brew install node` or [nodejs.org](https://nodejs.org)).

```bash
curl -fsSL https://raw.githubusercontent.com/reticlehq/reticle/main/install/install.sh | sh
```

Windows: `irm https://raw.githubusercontent.com/reticlehq/reticle/main/install/install.ps1 | iex`

It registers Reticle with your coding agents and shows it verifying a demo app, in seconds. Then open your agent in your app's folder and ask: _"Verify one flow in my running app with Reticle."_ The first time it uses Reticle there, it wires the app itself (the same thing `reticle init` does) and tells you every file it changed. No account needed, and nothing from your project leaves your machine.

<a id="manual-install"></a>
<details>
<summary>Other ways to install</summary>

<br/>

**Claude Code plugin:** `/plugin marketplace add reticlehq/reticle`, then `/plugin install reticle@reticlehq`.

**Skills CLI** (Cursor, Codex, Copilot, Gemini and others): `npx skills add reticlehq/reticle`

**No pipe to shell:** `npm install -g @reticlehq/server && reticle setup mcp`

**Any MCP client, by hand:** `{ "mcpServers": { "reticle": { "command": "npx", "args": ["@reticlehq/server", "mcp"] } } }`

Wire your app yourself instead of letting your agent do it: `reticle init` in the app's folder. Want a cloud dashboard? `reticle connect --project "My App"`. Not sure it worked? `reticle doctor`.

</details>

---

## Use it

You never write test syntax. You say what should be true, in plain English.

<p align="center">
  <img src="assets/readme/hero.gif" width="760"
       alt="An agent driving a real app through Reticle: it clicks, reads what actually happened, and returns a verdict." />
</p>

**Verify what you just built**

> "I changed checkout. Verify it with Reticle before you tell me it's done."

**Find what the screen is hiding**

> "The page looks fine but something's off. Use Reticle to check what's happening underneath."

**Prove a bug is fixed**

> "Reproduce the bug with Reticle, fix it, then prove the fix with the same steps."

**Lock a flow so it can't break**

> "Record the login flow with Reticle, then re-verify it after every change."

**Sweep before you ship**

> "Walk the main routes with Reticle. Tell me anything broken."

Reticle answers with evidence: the request that fired, the state that changed, the console line, and the file to open.

### What people use Reticle for

Anything the running app does is something an agent can check. Beyond verifying agent-built changes, people use Reticle for:

- **Security checks.** Access control holds for each role (the protected call returns `403`), forbidden calls fire zero times, a secret never renders in the page, and CSP violations surface as console errors. It proves your app's security behaviour and pairs with a vulnerability scanner, which finds the holes.
- **Accessibility and UX.** Controls are reachable by role and accessible name, focus moves into a dialog when it opens, and `Enter` or `Escape` fires the action from the keyboard. Pairs with a full WCAG audit such as axe.
- **Performance and monitoring.** One request per action instead of five, largest-contentful-paint, layout shift and long tasks read from the page, React render counts, and saved flows replayed against staging in CI.
- **SEO checks.** Page title, headings, every link with its `href`, redirects landing on the right route, and a crawl that finds dead controls and failed requests.
- **Personas and simulation.** `explore` drives a journey described in plain words (`--persona "a new user who signs up"`), each role gets its own isolated browser context, and several agents drive the same app in parallel.

Each one, with what it checks and a call you can run: [docs.reticle.sh/use-cases](https://docs.reticle.sh/use-cases).

**Make it unavoidable in CI**

```bash
npx @reticlehq/server gate --since HEAD~1
```

`gate` works out which saved flows your edits affect and exits non-zero unless a **passing** artifact covers each one. An agent that edits a covered file cannot call itself finished without re-verifying, and it is the one check nobody can satisfy by reasoning about their own diff. See [`docs/cli/gate.mdx`](docs/cli/gate.mdx).

---

## Why not Playwright?

Playwright, DevTools and browser agents all stand **outside** the browser looking in. For a site you don't own, that's right. For the app you're building, the bugs that matter never reach the pixels.

| Bug | Looks fine on screen? | Reticle reads |
| --- | :-: | --- |
| Pay button silently returns `500` | yes | the network response, tied to the click |
| Badge shows "12", the store holds `0` | yes | your app's state |
| The form fired the request twice | yes | request count |
| "Deploy succeeded", the deploy failed | yes | the store's real status |
| A console error slipped in | yes | the console since the action |
| Component re-renders 60×/sec | yes | the React commit stream |

**Use both.** Playwright for sites you don't own, many browsers, real pixels. Reticle for the app you're building, inside your agent's loop.

---

## The problem

Your agent writes code, **assumes** it worked, and moves on. It never opens the app.

So the broken modal, the silent `500`, the "Deploy succeeded" over a failed deploy: they all ship, and you find them by clicking around afterwards. **You've become your agent's QA.**

The truth was in the running app the whole time. It just never reached the screen.

<p align="center">
  <img src="assets/readme/silent-failures.png" width="540"
       alt="A page that looks shipped, hiding mock data, a dead click and a silent 500." />
</p>

This isn't something your agent forgot. A coding agent is built to **produce a change**, and it's optimistic by construction. Verification is the opposite motion: going to find out, and being willing to come back with **no**.

---

## How it works

> **You:** "Verify login works."
>
> **Agent, via Reticle:** clicks **Sign in** → `POST /api/login → 200 (14 ms)` → dashboard rendered → store holds `auth: { email: "admin@…" }` → **PASS**, evidence attached.

<p align="center">
  <img src="assets/readme/verdict-not-view.png" width="760"
       alt="Reticle watches the app from the inside: a broken Pay button traced to onPay.tsx line 46, handed to the coding agent as a repair packet." />
</p>

```mermaid
flowchart LR
    A["Your agent<br/>(Claude Code, Cursor…)"] -->|"look · act · observe · assert"| B(("Reticle"))
    B <-->|"structured events,<br/>not pixels"| C["Your running app<br/>DOM · network · console<br/>store · React fiber"]
    B -->|"verdict + evidence<br/>+ file:line"| A
    style B fill:#8b7bff,stroke:#5b4bd0,color:#fff
    style A fill:#15131f,stroke:#3a3550,color:#fff
    style C fill:#1c2433,stroke:#2f3d57,color:#fff
```

<p align="center">
  <img src="assets/readme/file-line-fix.png" width="700"
       alt="A failed verdict naming the exact source file and line to fix, rather than a screenshot to squint at." />
</p>

<sub align="center">A verdict points at the line that caused it. That pointer is the difference between "something broke" and a fix.</sub>

One call checks many things at once. Say _"save that as a flow"_ and it replays on every later edit with no model in the loop, so today's fix can't quietly break last week's feature.

<p align="center">
  <img src="assets/readme/regression-replay.png" alt="Re-driving a suite with an LLM burns tokens on every step, every run. Reticle records the flow once and replays it deterministically: no model, no flake, just a verdict." width="560" />
</p>

<details>
<summary><b>What one call looks like underneath</b></summary>

<br/>

```jsonc
// The agent clicked "Pay". Did the right things actually happen?
reticle_assert({
  predicate: { allOf: [
    { kind: "net",     method: "POST", urlContains: "/api/order", status: 200 },
    { kind: "element", query: { role: "dialog", name: "Order confirmed" }, state: "visible" },
    { kind: "signal",  name: "order:saved" },          // the charge actually committed
    { kind: "console", level: "error", absent: true }  // …and nothing errored
  ]}
})
// → { pass: false,
//     failureReason: "POST /api/order returned 500, expected 200",
//     source: { file: "src/checkout/PayButton.tsx", line: 42 } }
```

</details>

---

## Benchmarks

88 real regressions injected into a controlled app, Reticle against a Playwright script. Every number comes from a committed harness. Reproduce it with `pnpm bench`.

<p align="center">
  <img src="assets/readme/benchmark-chart.svg" width="880"
       alt="Reticle catches 14x more bugs where the screen looks right: 28 versus 2 across the six categories the two tools disagree on, and 85/88 versus 59/88 overall." />
</p>

<p align="center">
  <img src="assets/readme/chart-token-cost.svg" width="880"
       alt="Cumulative tokens to re-verify a four-flow suite over 100 runs: Reticle 128k, Playwright MCP 12.1M." />
</p>

Re-verification has no model in the loop, so a recorded suite is a fixed, tiny read. Reticle is ahead from the second run even when charged a full LLM drive to author the suite.

<p align="center">
  <img src="assets/readme/bench-rerun.png" width="840"
       alt="Re-running a four-flow suite: Reticle replays it in 47 tokens with no model and no flake, against about 120,000 tokens to re-drive it with an LLM." />
</p>

<p align="center">
  <img src="assets/readme/chart-speed.svg" width="880"
       alt="Wall-clock time to a verdict: a 2.6 second time-gated transition verified in 176 ms versus a 2,978 ms real wait, and a 16-flow batch in 5.2 seconds versus 31.7 seconds one at a time." />
</p>

Faster for a structural reason rather than a browser-speed one: a time-gated transition is verified from the event stream instead of waited out, and a batch of flows runs as a batch.

---

## Capabilities and limits

|  |  |
| --- | --- |
| **Strong** | silent failed requests, state that disagrees with the screen, stale caches, double-submits, a write that failed while the UI moved on |
| **Partial** | races around a single action. It detects `request-never-settled` and `duplicate-request`; it is not a scheduler-level race analyser |
| **Can't see yet** | IndexedDB, Web Workers, closed shadow roots, cross-origin iframes |

**When Reticle can't see something, it says so.** A verdict is `yes`, `no`, `unknown` (the evidence couldn't decide) or `no-fault` (nothing was declared to prove). Only `yes` is a pass; never a quiet one.

**Pairs well with:** a visual testing tool for pixel-level diffs, Playwright for sites you don't own and a cross-browser matrix, axe for full WCAG audits, and a security scanner for vulnerability discovery. Reticle checks what your own app does; those tools cover the rest.

---

## Built to be safe to install

- **Dev-only SDK.** It sits behind `import.meta.env.DEV` (the Vite plugin applies only to `serve`) and is dead-code eliminated from production builds, and a runtime guard refuses to connect when the build reports `NODE_ENV=production`.
- **Localhost-only bridge.** The daemon binds `127.0.0.1`, and an app pairs with it using a token stored owner-only at `~/.reticle/pairing-token`, so another page on your machine cannot drive your session.
- **No arbitrary code.** The SDK runs a fixed set of commands (look, act, read state, navigate). There is no "evaluate this JavaScript" tool.
- **Credentials redacted at the source.** Passwords, tokens, API keys and card numbers in captured request and response bodies, storage and state are replaced with `[REDACTED]` before they reach the agent.
- **Your app's data stays on your machine.** DOM, network bodies, console output, state and source are never sent anywhere, with one exception you switch on yourself: when the Harness drives with a model (yours or the platform's), that model sees the steps it drives. You need no account, and a verdict is produced locally. If you choose to connect a project (`reticle connect`, or `RETICLE_API_KEY` in CI), what syncs is yours to set with `reticle config --runs/--memory/--flows on|off`, and [what each contains is written down](docs/what-is-recorded.md).
- **Anonymous usage counts are sent by default:** which commands ran, which tools an agent called, whether a verdict was produced, with a random id and nothing from your app. `reticle telemetry disable`, `RETICLE_TELEMETRY=0` or `DO_NOT_TRACK=1` turns them off. [The complete list](docs/telemetry.md).
- **You see the plan first.** `init --dry-run` writes nothing; `--no-mcp` skips agent registration; `--files-only` writes the files and stops. Reporting a security issue: [SECURITY.md](SECURITY.md).

---

## Supported

|  |  |
| --- | --- |
| **Web** | React + Vite, Next.js, Remix and Astro are driven to a verdict in CI; more frameworks are install-gated or wired. **[Frameworks](docs/frameworks.mdx) is the one list of what is proven, and how far** |
| **Desktop** | Electron, Tauri, including the IPC boundary a browser-only tool can't see |
| **Agents** | anything that speaks MCP. Config written automatically for Claude Code, Cursor, Windsurf, VS Code, Zed, Gemini CLI, Copilot CLI, OpenCode, Warp, Kiro, Amazon Q, Cline, Amp, Continue, Factory Droid. Codex CLI is a printed four-line paste |
| **Browsers** | the SDK runs in the tab you already have open; the tested and driven browser is Chromium, plus Electron and Tauri webviews |
| **State** | zustand and Redux need no adapter. Shipped: TanStack Query, Jotai, XState, Valtio, MobX, Recoil, Svelte stores, Pinia |
| **OS** | macOS, Linux, Windows |

---

## The open-source tool, the Harness, and the dashboard

**The open-source tool is the whole verify loop, on your machine.** The SDK in your app, the local daemon, the MCP tools your agent calls, and the HUD in the corner of your page where you watch it work: what the agent is doing, every verdict, the flows it saved, the notes you pin on the page. No account, and nothing from your app leaves your machine.

**The Harness drives the app for you.** Describe a person and a journey (_"a returning customer reorders and pays"_) and the Harness drives it in your browser, proves each step, and saves what it drove as flows that replay with no model at all. Your agent spends one call instead of a context full of snapshots: on our explore benchmark the caller used 11.9× fewer tokens for the same verdict. It runs on the Reticle platform, on [TypeSafe AI](https://typesafe.ai)'s [Jev](https://typesafe.ai/blog/introducing-system-one-models-and-jev), a System One model built for fast, typed choices, and every plan includes it: Free comes with Harness credits each month, Pro with more, Enterprise with what you agree. You watch it in the HUD as it happens ("Reticle Harness is driving"), and you can switch it off mid-run from the same panel. Call it with `reticle_verify { action: "explore", persona: "…" }`; see [docs/autodrive.md](docs/autodrive.md).

**[app.reticle.sh](https://app.reticle.sh) is the dashboard.** Run `reticle connect` in your app, sign in, and everything your machine verified syncs on its own, whichever agent did the driving:

- every run, with what was checked, what held, and who drove it (your agent or the Harness)
- the bugs Reticle caught, to triage, assign, and push to GitHub
- saved flows, Reticle Coverage (routes reached, controls proved), and the notes people pinned in the HUD
- a team view of all of it, and a shareable proof link for any run

The open-source tool never needs the dashboard. The dashboard is where a team sees what its agents proved, and where the platform's Harness runs, on every plan, Free included.

## Docs

**[docs.reticle.sh](https://docs.reticle.sh)** — a page per tool, a page per command, every example captured from a real run.

[Quickstart](https://docs.reticle.sh/quickstart) · [Frameworks](https://docs.reticle.sh/frameworks) · [Troubleshooting](https://docs.reticle.sh/troubleshooting) · [Architecture](docs/architecture.md) · [Contributing](CONTRIBUTING.md)

## Get help and community

**[Join the Discord →](https://discord.gg/BwAbzv9ZRz)** Where the work happens in the open: what's being built, what's up for grabs, and design calls before they land.

Stuck on setup, or want to talk through your use case? [Book a call with the founders](https://calendar.app.google/h9NRDbBBQetyTzWM6), or open an [issue](https://github.com/reticlehq/reticle/issues).

<a href="https://github.com/reticlehq/reticle/graphs/contributors"><img src="https://contrib.rocks/image?repo=reticlehq/reticle" alt="Contributors" /></a>

If Reticle proves useful, a ⭐ helps other developers find it.

## License

- **The SDK, adapters, core and engine are Apache-2.0.** Ship them inside your own apps.
- **The server, CLI and `init` are FSL-1.1-ALv2:** free for any use except offering Reticle itself as a competing product or service, and each version becomes Apache-2.0 two years after release.
- **Enterprise features need a license key** in production; they are free for development and evaluation.

[LICENSE](LICENSE) has the details.

`dev-only` · `localhost-only` · `your app data stays local`
