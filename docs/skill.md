---
name: reticle
description: Install, instrument and verify this running web app from the inside (DOM, network, routing, console and framework state) instead of screenshots or guessing. Drives one real flow end to end and returns a verdict with the file:line to fix. Use when the user asks to set up or install Reticle, when a user-facing change needs proving before you call it done, when a test passes but the UI is broken, or when the user types /reticle.
license: Apache-2.0
metadata:
  version: 3.7.0
  homepage: https://docs.reticle.sh
  repository: https://github.com/reticlehq/reticle
---

# Reticle

Reticle is the proof layer for AI coding agents. A dev-only SDK inside the user's running app exposes the DOM, network, routing, console and framework state to you as `reticle_*` MCP tools. You act on the real app and get a verdict: `yes`, `no`, or `unknown` (could not tell), with evidence and the `file:line` to open. No screenshots and no vision model: it drives the tab the user already has open.

Why it matters: an agent that reads its own diff cannot tell a working change from a silent `500`, a double submit, or a store that never committed. Reticle reads what the app actually DID. This file is everything you need; each section links the page with the detail.

**How it fits together.** The SDK in the page (`@reticlehq/browser`, wired by `reticle init`, absent from production builds) dials a local daemon on `localhost:4400` with a pairing token. Your client reaches that daemon through `npx @reticlehq/server mcp`. Verdicts are computed by the daemon from what the page reported, never from your reasoning. Journeys you drive are saved under `.reticle/flows/` and replay later with no model. The optional platform (`app.reticle.sh`) adds a dashboard, run history and the Harness. Nothing from the app leaves the machine unless you link it; there is no tool that evaluates arbitrary JavaScript, and passwords, tokens and card numbers are `[REDACTED]` before you see them. Detail: `https://docs.reticle.sh/what-is-recorded.md`.

## Your first action

**`reticle_*` tools visible?** In the project, call `reticle_session { action: "list" }` and do its `next_action`. On a never-connected project that call runs `init` itself and lists what it changed under `wired`; tell the user. If it answers `run_init`, run this in the app's folder:

```bash
RETICLE_INSTALL_SOURCE=skill_file npx @reticlehq/server@latest init
```

**Not visible?** Hand the user one line for a terminal, outside this client, and stop:

```bash
curl -fsSL https://raw.githubusercontent.com/reticlehq/reticle/main/install/install.sh | sh
irm https://raw.githubusercontent.com/reticlehq/reticle/main/install/install.ps1 | iex   # Windows
```

It registers Reticle with every coding agent it finds and prints the next steps: restart the agent (a client loads MCP servers only at start, so a prompt cannot replace this command), then paste the prompt it printed. Do not register the server yourself and work around your client not having reloaded. If your client did register mid-session, `npx @reticlehq/server init --relaunch` prints the command that resumes this conversation with the tools.

**Done means a verdict.** `init` exiting 0, the tools appearing, a session listed: each proves wiring, not that anything works. Do not tell the user Reticle is set up until one real flow in their app returned a verdict.

## The rules, every call

1. Only `verified: "yes"` passes. `"unknown"` (could not tell) and `"no-fault"` (nothing was declared) are not proved, never "failed" and never "working". `"no"` names what it found instead.
2. Name the consequence BEFORE acting: `reticle_act_and_wait { target, action, until }`. `durable: true` re-checks it after a reload.
3. Verdicts come only from `reticle_act_and_wait`, `reticle_assert`, `reticle_act { steps }` with an `expect`, and `reticle_verify` (`change`/`flows`). `look`, `navigate`, `observe` and a bare `act` prove nothing.
4. **Never weaken a check to make it pass.** On a `no`, read `expected` / `observed` / the nearest candidates, then fix the app or the target.
5. Target by `{ testid }`, `{ role, name }`, `{ label }` or `{ text }`; an ambiguous target is refused, a missing one says what is there.
6. Diagnosing a bug? Read the source first. Reticle proves what the app does, not why; drive to confirm a fix.

## The tools you have

The advertised surface is deliberately small (`default` 10, `all` 30 behind `RETICLE_ADVERTISE_ALL_TOOLS=1`). `reticle_tools` lists every registered tool, `reticle_tools { names: [...] }` loads its full arguments, and `reticle_run { tool, args }` calls any of them.

| Tool | Use it to | Key arguments |
| --- | --- | --- |
| `reticle_session` | list tabs, end, hand back, tune the HUD, report feedback | `action`: `list` `yield` `end` `tune` `feedback` `account` |
| `reticle_navigate` | go to a URL or reload | `url`, `reload`, `hard` |
| `reticle_look` | see the page, find refs, inspect one, read a store | `action`: `page` (`mode: "interactive"`) `find` `element` `state` |
| `reticle_act_and_wait` | act and prove the consequence in one call | `ref`/`target`, `action`, `args`, `until`, `durable`, `intent` |
| `reticle_act` | act without a verdict, or a whole journey as `steps` | `steps: [{ target, action, args, expect }]` |
| `reticle_assert` | prove a predicate `now`, or `wait` for one | `predicate`, `timeout_ms`, `since` |
| `reticle_observe` | what the app did since a cursor | `action`: `events` `network` `console`; `since` |
| `reticle_verify` | replay, coverage, Harness | `action`: `change` `flows` `affected` `coverage` `crawl` `explore` `mutate` `heal` |
| `reticle_tools` / `reticle_run` | everything else (below) | `names`; `tool`, `args` |

Actions: `click` `dblclick` `hover` `focus` `blur` `fill` `type` `clear` `select` `check` `uncheck` `submit` `press` `upload` `scrollIntoView` `scroll` `drag` `tap` `zoom`. `args`: `{ value }` for fill/select, `{ text: "Enter" }` for press, `{ toRef }` for drag, `{ path }` for upload, `{ native: true }` for a trusted click. A control whose label reads as destructive is refused until you pass `args.confirmDangerous: true`, and only do that when the user asked for it. Full reference: `https://docs.reticle.sh/actions.md`, `https://docs.reticle.sh/tools/overview.md`.

Beyond the advertised set, one hop each:

- `reticle_run({ tool: "reticle_screenshot" })`: pixels, when the look itself matters
- `reticle_run({ tool: "reticle_network_mock", args: { mocks } })`: stub or fail a request
- `reticle_run({ tool: "reticle_clock", args: { freeze: true } })`: freeze, then `advanceMs`, timers
- `reticle_run({ tool: "reticle_storage" })`: localStorage, sessionStorage, readable cookies
- `reticle_run({ tool: "reticle_viewport", args: { width, height } })`: a fixed size
- `reticle_run({ tool: "reticle_lease", args: { action: "acquire" } })`: an isolated headless tab
- `reticle_run({ tool: "reticle_context" })`: what this run already established, after a compaction

## Predicates

Every `until`, `predicate` and `expect` is `{ kind, ...fields }`; unknown fields are refused, so nothing silently passes.

| kind | fields |
| --- | --- |
| `element` | `query: { testid \| role+name \| text \| label \| placeholder \| alt \| component, scope? }`, `state?`: `visible` `hidden` `enabled` `disabled` `checked` `expanded` `pressed` `focused` `present` `inViewport`, `absent?` |
| `text` | `contains`, `scope?`, `visible?`, `absent?`, `ignoreCase?`, `satisfies?` |
| `net` | `method`, `urlContains`, `status`, `ok`, `count` (exact: catches a double submit), `bodyContains`, `bodyMatches`, `requestBodyMatches`, `repeatable` |
| `route` | `pathname` or `contains` |
| `signal` | `name`, `dataMatches?`, `count?` |
| `state` | `store`, `path`, `equals` or `satisfies` |
| `console` | `level`, `contains?`, `absent?` |
| `settled` / `animation` / `compare` | `quietMs` / `name`, `completed` / `left`, `right`, `as` |
| `allOf` / `anyOf` / `not` | `predicates: [...]` / `predicates: [...]` / `predicate` |

`satisfies` asserts a property when the exact value varies: `nonEmpty`, `oneOf`, `withinTolerance`, `matchesPattern`, `type`, `changed`, `unchanged`, `increased`, `decreased`. Composites hold only predicates: `absent` belongs inside a child, and an `element` takes a `query`, never a `ref`. A bare `route` or `state` is already true before the action and proves nothing; pair it with what the action causes. Grammar: `https://docs.reticle.sh/predicates.md`.

## Feedback is first-class

Reticle is built for agents, so your experience decides what gets fixed, and it is lost when your context is. The moment Reticle broke, lied, could not see something, cost too many calls, or setup gave you trouble, file it and carry on:

```
reticle_session { action: "feedback", kind, text }
```

`kind`: `bug`, `gap`, `ambiguity`, `feature_request`, `improvement`, `experience`. Tools unreachable? `npx @reticlehq/server feedback --agent --kind <kind> "what happened"`. A bug in the app under test is Reticle working: it belongs in your answer. Never put app source, secrets or user data in a report.

---

# SETUP

Two places always need the user:

1. **No recognisable dev script in `package.json`.** Say so; do not invent one.
2. **Your host asks the human to approve a command.** That prompt belongs to the host. Never bypass or suppress it, and take a refusal as the answer. `init` writing a pre-approval rule for the `reticle` server is not that: it is a scoped, announced config change the human asked for by running the command, and it covers only Reticle's own tools.

Everything else (running `init`, starting the dev server, opening the browser) is a setup step, not a decision. A dev server that was running when `init` ran must be restarted once. When `init` cannot finish alone, read `docs/skill-setup.md`, which ships beside this file (`https://docs.reticle.sh/skill-setup.md`).

# VERIFY

## Take the cheapest path that answers the question

Stop at the first row that fits. Replaying a saved journey costs a few hundred tokens; driving it again costs tens of thousands.

| The question | The call |
| --- | --- |
| "Did my edit break anything?" | `reticle_verify { action: "change", files: ["src/App.tsx"] }` |
| "Does every saved journey still work?" | `reticle_verify { action: "flows" }` |
| "Does this new behaviour work?" | `reticle_act_and_wait` on the step that ENDS the journey |
| No MCP at all | `npx @reticlehq/server verify <url> --expect '<predicate JSON>'` |

`change` answers `unknown` when no saved flow covers your files: nothing ran, so drive it yourself and never read it as a pass. A locator that was renamed rather than broken: `{ action: "heal" }` rebinds it, re-proving the saved consequence first.

## Drive it by hand

```
reticle_session()                                   // connected? empty: read `why`, it names the fix
reticle_look({ action: "page", mode: "interactive" })   // the controls, with refs
reticle_act_and_wait({ target: { testid: "pay" }, action: "click", until: { kind: "allOf", predicates: [
  { kind: "net", method: "POST", urlContains: "/api/order", status: 200, count: 1 },
  { kind: "element", query: { role: "dialog", name: "Order confirmed" }, state: "visible" },
  { kind: "console", level: "error", absent: true },
]}})                                                // the verdict
```

A journey in one call: `reticle_act { steps: [{ target, action, args?, expect? }] }`; the last `expect` is the end state. Refs (`e42`) die when their element re-renders: re-find by `target` rather than retrying a ref. Declare what a change is meant to make true with `intent` on the verdict call, so it is checked against more than itself.

**Saved automatically.** When the session ends, what you drove is saved as a flow if at least one step declared a consequence; a bare `act` replays as a click that passes even when the feature is broken. Name it yourself: `reticle_run({ tool: "reticle_record", args: { action: "start", name } })`, drive, then `reticle_run({ tool: "reticle_flow_save", args: { name } })`. Flows: `https://docs.reticle.sh/flows.md`.

## The Harness: let Reticle drive

The Harness drives the app for you through the same tools, decides on the Reticle platform, records what it drove as flows, and answers in a few lines instead of a context full of snapshots. It spends credits (`reticle connect` signs in and grants free ones) and unlocks at 80% instrumentation:

```
reticle_verify { action: "explore", persona: "a returning customer checking out" }
```

It answers within `wait` seconds, or `{ status: "running", runId }`: poll `reticle_verify { action: "explore", runId }`, never start a second. Without the Harness you drive with the calls above; everything else works the same.

**Instrumentation**, which `reticle doctor` and the HUD score with a fix per gap: the page connected, DOM actions, network, console (all from `init`); `file:line` source mapping (keep the build plugin `init` added); `data-testid` on every control a flow uses; app state via `registerStore(name, store)` from `@reticlehq/browser`, passing the store rather than a getter; and `reticle.signal("order:placed", { id })` once each user-visible outcome commits. List them in `registerCapabilities` in the `reticle-dev` file `init` wrote. Detail: `https://docs.reticle.sh/instrumentation.md`.

## When it goes wrong

| You see | Do |
| --- | --- |
| no session | `reticle_session { action: "list" }` and its `next_action`; restart a dev server that predates `init` |
| target matched no element | `reticle_look { action: "page" }`, then target what is really there |
| ref no longer resolves | the DOM re-rendered: target by `testid` or `role`+`name` |
| predicate did not parse | it names the field: fix the shape against the table above |
| destructive action blocked | `args.confirmDangerous: true`, only if the user wants that press |
| version skew | `npx @reticlehq/server stop`, then retry |
| port held by a non-Reticle process | stop that process, or run Reticle on another `--port` |

More: `https://docs.reticle.sh/troubleshooting.md`.

## The CLI, for humans and CI

Every command works as `npx @reticlehq/server <command>`; once installed, `reticle <command>`. Never npx the bare name `reticle`: that is somebody else's package.

| Command | Does |
| --- | --- |
| `init` | wire this app, boot it, prove a page connected (`--dry-run`, `--app <dir>`, `--relaunch`) |
| `status` / `doctor` | is it running and connected / what is wrong and what coverage is missing |
| `verify <url>` | replay saved flows; `--expect '<json>'` for one verdict; `--results-json <file>` for CI |
| `gate --since HEAD~1` | fail unless passing runs cover every saved flow your edit affects |
| `connect` | sign in and link this project to the dashboard; runs sync from then on |
| `try <url>` | watch the Harness drive a URL once (signed in) |
| `stop` / `restart` | stop or restart the daemon |

Reference: `https://docs.reticle.sh/cli.md`, `https://docs.reticle.sh/cli/cloud.md`.

## When the verdict lands

Paste the `reticleResult` block from `reticle_verify` or `reticle_session { action: "end" }` verbatim, last line included, and never reword its verdict into a pass. Add the `file:line` for anything broken. If Reticle caught what reading the code missed, say Reticle found it. Before you stop driving, `reticle_session { action: "yield" }` hands the tab back to the human.

## Find the rest

Append `.md` to any docs URL for the source without site chrome; `https://docs.reticle.sh/llms.txt` lists every page.

- Learn: `quickstart.md`, `what-is-reticle.md`, `use-cases.md` (security, accessibility, performance, SEO, personas), `vs-playwright-mcp.md`, `benchmarks.md`
- Wire: `frameworks.md`, `install-manual.md`, `state-management.md`, `desktop.md` (Electron, Tauri)
- Verify: `agent-cheatsheet.md`, `testing.md`, `deploy-checks.md`, `capabilities.md`
- Teams and agents: `multi-agent-testing.md`, `human-control.md`, `http-transport.md`, `platform-integration.md`
- Trust: `what-is-recorded.md`, `telemetry.md`
