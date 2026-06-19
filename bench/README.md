# Browser-verification benchmark — reproducibility

Compares **Playwright MCP**, **Chrome DevTools MCP**, and **Iris** across detection, regression-run
cost, and hard UI/state bugs. Everything here is measured by the harness; nothing is hand-entered.

**Start here: [`SCORECARD.md`](SCORECARD.md)** — the honest one-page standing across all layers
(wins, ties, and caveats). Depth lives in: `METRIC.md` (chased metric: VE gate + RRE), `LAYER-B.md`
(real agent loop + Layer C / RRE), `HARD-BENCH.md` (hard UI/state bugs — visual = parity, state-desync
= Iris-only), and `METHODOLOGY.md` (full design: controls, scenarios, fairness). Gate: `pnpm bench` /
`bench:full` / `bench:gate` (fail on regression vs the last `history.jsonl` row).

## Layout

```
METHODOLOGY.md            full design: controls, scenarios, 2 layers, fairness, fixes
harness/                  all runnable code
  mcp-client.mjs          minimal JSON-RPC stdio MCP client (drives any MCP server, no LLM)
  tokenizer.mjs           exact chars/bytes + tiktoken o200k_base PROXY (labeled, not Anthropic)
  adapters.mjs            per-tool login/navigate/act/observe, every call measured
  inject.mjs              deterministic regression injector (git-revert)
  run-observation.mjs     Layer A: observation-cost suite (10x3), writes raw/observation-results.json
  agent-loop.mjs          Layer B: real Claude tool-use loop, authoritative usage tokens (needs API key)
  analyze.mjs             Phase 4 aggregates -> raw/analysis.json
  charts.mjs diagrams.mjs Phase 5 SVG generators
  svg2png.mjs             SVG -> PNG via headless Chromium
  capture-screens.mjs     real failure-state screenshots + console/network evidence
  probe.mjs schema-dump.mjs   connectivity + tool-schema probes
raw/                      measured outputs (observation-results.json, analysis.json, snapshot-*, run-meta.json)
logs/                     run logs (observation-run*.log, demo/api logs)
artifacts/                charts + diagrams (SVG + PNG) + screens/ (real PNGs + evidence)
```

## Prerequisites

- Node v22+, pnpm, `python3` with `tiktoken` (proxy tokenizer; harness degrades gracefully without it).
- Playwright Chromium installed (`pnpm exec playwright install chromium`), local Chrome (DevTools MCP).
- `@syrin/iris-server` built: `pnpm build` (the harness runs `node packages/server/dist/cli.js mcp`).

## Run it

```bash
# 1. backend + a dedicated demo whose embedded Iris SDK dials port 4455
node apps/api/server.mjs &
IRIS_PORT=4455 pnpm --filter @syrin/iris-demo exec vite --port 4312 --strictPort &

# 2. (scenario 9 only) add the hanging endpoint to apps/api/server.mjs before /api/health,
#    then restart the api. This is the ONLY source change the benchmark needs in the app:
#
#      app.get('/api/broken/timeout', (_req, _res) => { /* never responds */ });
#
#    (Left out of the committed tree on purpose; add it to reproduce network-timeout.)

# 3. prove all three servers boot and list tools
node plan/bench/harness/probe.mjs

# 4. Layer A — observation cost (no API key). ~12 min; spawns each tool's browser per cell.
node plan/bench/harness/run-observation.mjs

# 5. analysis + visuals
node plan/bench/harness/analyze.mjs
node plan/bench/harness/charts.mjs && node plan/bench/harness/diagrams.mjs && node plan/bench/harness/svg2png.mjs
node plan/bench/harness/capture-screens.mjs

# 6. Layer B — full agent loop (authoritative usage tokens). REQUIRES a key.
ANTHROPIC_API_KEY=sk-... node plan/bench/harness/agent-loop.mjs
```

## Pinned versions (from raw/run-meta.json)

`@playwright/mcp@0.0.76`, `chrome-devtools-mcp@1.3.0`, `@syrin/iris-server@0.6.10`,
Node v22.14.0, Playwright `chromium-1223`, host Darwin arm64.

## What is and isn't measured

- **Measured (Layer A):** exact payload chars/bytes + proxy tokens, wall-clock latency,
  detection vs a fixed rule, across 27/30 cells (cross-component is NOT MEASURED — see below).
- **NOT MEASURED:** Layer B agent-reasoning tokens (no API key in the run environment);
  `cross-component-regression` (needs a biased per-tool row-counting heuristic);
  steady-state latency (the measured latency is cold-start-dominated).

## Teardown gotcha (Iris)

`iris mcp` starts a _persistent_ daemon. Orphaned daemons + their browsers accumulate and
register concurrent sessions on the shared bridge ("multiple sessions connected"). The
adapter calls `iris stop --port` on shutdown; if you interrupt a run, clean up with:

```bash
pkill -f "cli.js _daemon"; pkill -f "cli.js mcp"; pkill -f chrome-headless-shell
node packages/server/dist/cli.js stop --port 4455 --quiet
```
