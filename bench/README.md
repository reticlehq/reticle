# Browser-verification benchmark — reproducibility

> **`bench/` is measurement, not a gate.** Nothing in this directory runs in CI, and nothing here blocks a PR. It is allowed to bit-rot in a way a gate is not — so before trusting a number, check the table below for whether that script is still driven by anything. Merge gates live in [`docs/gates.md`](../docs/gates.md).

Compares **Playwright MCP**, **Chrome DevTools MCP**, and **Reticle** across detection, regression-run cost, and UI/state bugs. Everything here is measured by the harness; nothing is hand-entered.

**About to quote a number? Run `pnpm bench:dashboard` first.** `dashboard.mjs` regenerates the whole scorecard from the run artifacts on disk and prints `not measured — run <command>` for anything missing, so it is the one view here that structurally cannot go stale: there is no place to hand-write a figure into it. It existed for months and nothing pointed at it, which is a large part of why three different values for one metric ended up in circulation. Prefer it over any figure typed into a markdown table, including the ones below.

**Start here: [`SCORECARD.md`](SCORECARD.md)** — the honest one-page standing across all layers (wins, ties, and caveats), and **read its freshness banner first**. Depth lives in: `METRIC.md` (chased metric: VE gate + RRE), `agent-loop-and-replay.md` (real agent loop + Layer C / RRE), `UI-BUG-BENCH.md` (UI/state bugs — visual = parity, state-desync = Reticle-only), and `METHODOLOGY.md` (full design: controls, scenarios, fairness). Run it with `pnpm bench` / `bench:full` / `bench:gate`.

## What in here is live — every script, executed 2026-08-11

`harness/` holds 39 files and only twelve are driven by a suite. The rest are **kept one-off studies**: each produced a number in a published scorecard, and deleting one would leave that claim with no reproduction. That is deliberate, and the cost is that "a file exists in `harness/`" told you nothing about whether it still ran.

So they were all run. **Every script below passes.** The two defects that surfaced are fixed:

- `suite-rre.mjs` recorded flows that asserted nothing and then demanded a `pass` verdict, which `reticle_flow_verify` correctly refuses — so **`pnpm bench` exited 1** and `replay-determinism` never ran at all. Each flow now carries a success oracle.
- `clock-timetravel.mjs` failed on `reticle_clock {reset:true}` with `TypeError: Illegal invocation`. That one was **not a bench bug** — see "A product bug this directory caught" below.

**The prerequisite column is the point.** Every script that looked broken during this sweep was actually a script whose fixture nobody had started, and that is why "which of these works" was unanswerable.

| Class | Scripts | Prerequisite | Status |
| --- | --- | --- | --- |
| **Replay pass** — the regression floor | `replay-bench`, `replay-detect`, `replay-detect-consequence`, `replay-detect-state`, `network-cardinality-bench`, `forbidden-call-bench`, `console-clean-bench`, `state-blast-radius-bench`, `suite-rre`, `replay-determinism` | `pnpm bench` boots its own | ✅ 10/10, 279s |
| **Entry points** | `bench-all`, `gate` | — | ✅ |
| **Shared libraries** — imported, never run alone | `adapters`, `mcp-client`, `tokenizer`, `inject`, `ports`, `record` | — | ✅ (via callers) |
| **Diagnostics** | `probe` · `schema-dump <playwright\|devtools\|reticle>` | bench fixtures; `schema-dump` **requires the tool as argv[2]** and crashes without it | ✅ |
| **Reticle-only studies** | `clock-timetravel`, `source-localize`, `render-storm-bench`, `state-desync-bench`, `leak-stress`, `multi-agent-throughput`, `schema-tax` | bench fixtures (api `:8787` + bench-app `:4312`) | ✅ |
| **Needs another fixture** | `stress-tiers`, `measure-large-dom` | `apps/large-dom-bench` on **`:4313`** — without it they fail in a way that reads like rot | ✅ `stress-tiers` |
| **Needs a prior run** | `compiled-suite-vs-replay` | run `suite-rre.mjs` first (it consumes the saved flows) | ✅ |
| **Needs competitor MCPs + network** | `visual-bug-bench` | downloads `@playwright/mcp` + `chrome-devtools-mcp` via npx | ✅ parity 6/6/6 |
| **Rendering / reporting** | `charts`, `make-readme-chart`, `../dashboard.mjs` | existing raws | ✅ |
| **Not run in this sweep** | `run-observation` + `analyze` (~12 min, drives competitors), `claude-agent-loop` / `openai-agent-loop` (**needs an API key**), `capture-screens`, `visual-regression-bench` (needs `reticle drive`) | as noted | ⚠ unverified |

The subdirectories (`fix-loop/`, `honesty/`, `pw-vs-reticle/`, `diagnosis/`, `first-drive/`, `overhead/`, `parallel-suite/`, `oracle-guards/`, `e2e-loop/`, `desktop/`) are each a completed study with its own README and results file, and were **not** re-run here. Same rule: evidence for a published claim, run by hand, not a gate.

**Adding a script?** Put it in a class above **with its prerequisite**. A script whose fixture is undocumented is one that will be misdiagnosed as rotted by whoever runs it next.

### Hazard: `charts.mjs` rewrites published assets from whatever is on disk

`bench/artifacts/chart-detection.svg` and `chart-avg-tokens.svg` are committed and embedded in [`docs/benchmarks.md`](../docs/benchmarks.md). Running `charts.mjs` regenerates them from the **current** `raw/analysis.json` — with no check that those raws came from a complete Layer A pass.

Run during this sweep, it silently redrew the detection chart with Chrome DevTools MCP at **82 instead of 91**, sourced from **32/36 cells instead of 33/36** — a partial dataset from a run nobody had performed. Committing that would have published a worse number about a competitor on the strength of leftover files. The change was reverted.

**So: only commit a regenerated chart when you have just run a full `pnpm bench:full`, and diff the footer cell count before you do.** A competitive benchmark that gets a rival's score wrong in its own favour, by accident, is worth less than no benchmark.

## A product bug this directory caught

`clock-timetravel.mjs` failed on `reticle_clock {reset:true}` with `TypeError: Illegal invocation`. The cause was in the SDK, not the bench: `resetClock()` re-armed the app's pending timers by calling the captured natives off a plain object (`natives.setTimeout(...)`), so the DOM received a foreign `this` and refused. An early return when nothing is pending meant it fired **only** when the app had actually queued work during the freeze — the exact case the function exists to serve.

Every unit test passed throughout, because jsdom does not enforce the receiver. Only a real browser does, and in this repo the things that drive a real browser are the e2e battery and this directory. That is the argument for keeping `bench/` alive even though it gates nothing: it is one of the few places a jsdom-invisible defect can surface. Fixed in `packages/browser/src/timers/clock.ts`, with three tests that install a WebIDL-faithful strict double and go red without the fix.

## Layout

```
METHODOLOGY.md            full design: controls, scenarios, 2 layers, fairness, fixes
harness/                  all runnable code
  mcp-client.mjs          minimal JSON-RPC stdio MCP client (drives any MCP server, no LLM)
  tokenizer.mjs           exact chars/bytes + tiktoken o200k_base PROXY (labeled, not Anthropic)
  adapters.mjs            per-tool login/navigate/act/observe, every call measured
  inject.mjs              deterministic regression injector (git-revert)
  run-observation.mjs     Layer A: observation-cost suite (10x3), writes raw/observation-results.json
  claude-agent-loop.mjs   Layer B: real Claude tool-use loop, authoritative usage tokens (needs API key)
  analyze.mjs             Phase 4 aggregates -> raw/analysis.json
  charts.mjs              Phase 5 SVG chart generator
  capture-screens.mjs     real failure-state screenshots + console/network evidence
  probe.mjs schema-dump.mjs   connectivity + tool-schema probes
raw/                      measured outputs (observation-results.json, analysis.json, snapshot-*)
                          NOTE: run-meta.json is referenced in older text but is no longer produced.
logs/                     run logs (observation-run*.log, demo/api logs)
artifacts/                charts + diagrams (SVG + PNG) + screens/ (real PNGs + evidence)
```

## Prerequisites

- Node v22+, pnpm, `python3` with `tiktoken` (proxy tokenizer; harness degrades gracefully without it).
- Playwright Chromium installed (`pnpm exec playwright install chromium`), local Chrome (DevTools MCP).
- `@reticlehq/server` built: `pnpm build` (the harness runs `node packages/server/dist/cli.js mcp`).

## Run it

> [!WARNING] The benchmark **rewrites tracked files in the fixture app** and reverts them with `git checkout --`: `apps/bench-app/src/store/store.ts`, `src/components/NewDeployModal.tsx`, `src/views/Overview.tsx` and `src/views/Diagnostics.tsx`. Commit or stash any work in those four before running — the injector refuses to start if they are dirty, but nothing else protects them. If a crashed run left a regression injected, clear it with `node bench/harness/inject.mjs --revert-all`.

The fast path: `pnpm bench` (the replay pass) and `pnpm bench --full` (+ observation-cost pass) now **boot the fixtures themselves** — the bench-app on `:4312` and the api on `:8787` — health-check them, and tear them down on exit. Pass `--no-boot` to use fixtures you already have running, and override ports with `BENCH_DEMO_PORT` / `BENCH_API_PORT` / `BENCH_RETICLE_PORT` (default 4460 — the same value apps/bench-app/vite.config.ts defaults to; see bench/harness/ports.mjs for why they must agree). On a slow machine raise `BENCH_FIXTURE_READY_MS` (fixture boot) or `BENCH_RETICLE_READY_MS` (driven-browser connect).

To run the fixtures + harness scripts by hand instead (e.g. for the manual observation/agent-loop steps):

```bash
# 1. backend + a dedicated demo whose embedded Reticle SDK dials port 4460
node apps/api/server.mjs &
RETICLE_PORT=4460 pnpm --filter @reticlehq/bench-app exec vite --port 4312 --strictPort &

# 2. (scenario 9 only) add the hanging endpoint to apps/api/server.mjs before /api/health,
#    then restart the api. This is the ONLY source change the benchmark needs in the app:
#
#      app.get('/api/broken/timeout', (_req, _res) => { /* never responds */ });
#
#    (Left out of the committed tree on purpose; add it to reproduce network-timeout.)

# 3. prove all three servers boot and list tools
node bench/harness/probe.mjs

# 4. Layer A — observation cost (no API key). ~12 min; spawns each tool's browser per cell.
node bench/harness/run-observation.mjs

# 5. analysis + visuals
node bench/harness/analyze.mjs
node bench/harness/charts.mjs
node bench/harness/capture-screens.mjs

# 6. Layer B — full agent loop (authoritative usage tokens). REQUIRES a key.
ANTHROPIC_API_KEY=sk-... node bench/harness/claude-agent-loop.mjs

# 7. Layer C — deterministic regression suite (no API key). Records each flow once, then replays it
#    with NO model and asserts a declared consequence. This is the RRE / regression story + the
#    Reticle-only catches. Needs the demo (step 1) up; each harness self-drives its own reticle session.
pnpm bench            # bench-all: replay-bench + replay-detect(+consequence/state) + suite-rre +
                      #   network-cardinality (double-submit) + console-clean + state-blast-radius +
                      #   replay-determinism (flake rate). Exits non-zero if any dimension regresses.
pnpm bench:gate       # compare the fresh raws vs the last history.jsonl row; fail on regression.
                      # It now NAMES any dimension with no baseline instead of reporting a clean
                      # bill of health over zero comparisons — which is what it used to do, because
                      # the last recorded row carries no layer_c keys.
```

## Versions the competitive numbers were measured against — READ BEFORE QUOTING

A competitive benchmark is only as current as the versions it ran against, and these have drifted. `raw/run-meta.json` used to record them; **that file is not produced any more and is not in the tree**, so the row below is maintained by hand until something regenerates it. Treat it as the expiry date on every cross-tool number in `SCORECARD.md`.

| Tool | Measured against | Latest upstream (checked 2026-08-11) | Drift |
| --- | --- | --- | --- |
| `@playwright/mcp` | `0.0.76` | `0.0.79` | 3 patch releases |
| `chrome-devtools-mcp` | `1.3.0` | `1.7.0` | **4 minor releases** |
| `@reticlehq/server` (us) | `0.8.0` | `2.5.0` | **our own numbers are 1.7 major versions old** |

Host at measurement time: Node v22.14.0, Playwright `chromium-1223`, Darwin arm64.

**The cross-tool comparison has not been re-run since 2026-06-22.** Both competitors have shipped since, and so have we — by far the larger gap. The deterministic replay pass (`pnpm bench`) is re-run often and its numbers are current; the observation-cost pass, which is the only one that drives Playwright and DevTools, needs `pnpm bench:full` and a re-record. Until that happens, quote the replay numbers freely and treat every Playwright/DevTools column as historical.

## What is and isn't measured

- **Measured (Layer A):** exact payload chars/bytes + proxy tokens, wall-clock latency, detection vs a fixed rule, across 27/30 cells (cross-component is NOT MEASURED — see below).
- **NOT MEASURED:** Layer B agent-reasoning tokens (no API key in the run environment); `cross-component-regression` (needs a biased per-tool row-counting heuristic); steady-state latency (the measured latency is cold-start-dominated).

## Teardown gotcha — the failure that wastes the most time here

`reticle mcp` starts a _persistent_ daemon. Orphaned daemons and, more importantly, their **browsers** outlive an interrupted run and keep a session registered on the bench port. Every harness that does not pass an explicit `sessionId` then dies on:

```
tool reticle_query failed: multiple sessions connected — pass sessionId to target one
```

This does not look like leftover state; it looks like the script is broken. Three scripts were diagnosed as rotted on exactly this evidence and all three were fine — the actual culprit was a `--drive` daemon from an earlier run still holding a headless Chromium against `:4312`.

**Check before you conclude a script is broken:**

```bash
pgrep -fl "cli.js _daemon"          # daemons still listening
pgrep -f chrome-headless-shell | wc -l   # browsers still attached
```

**Clean up:**

```bash
node packages/server/dist/cli.js stop --port 4460 --quiet   # the polite way, first
pkill -f "cli.js _daemon"                                   # then anything that ignored it
pkill -f chrome-headless-shell
```

> **Never add `pkill -f "cli.js mcp"` to that list**, which this file used to recommend. That pattern matches the `reticle mcp` **proxy your own agent is talking through**, so running it mid-session kills your MCP connection — and it presents as "Reticle went down", which is the single most reported bug in this project. Kill the `_daemon` and the browser; leave the proxy alone. The same reasoning is why the e2e battery filters port 4400 with `-sTCP:LISTEN` (see [`apps/e2e/harness-rules.md`](../apps/e2e/harness-rules.md)).
