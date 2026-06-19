# Iris benchmark scorecard — the honest one-page standing

> One synthesis of everything measured, across all layers. Wins, ties, and caveats stated plainly —
> no inflation. Every number is produced by a committed harness; detail + raw data linked per row.
> Tokens are the `o200k` proxy unless a row says "authoritative usage" (Layer B).

## The metric we chase

**Regression-Run Efficiency (RRE): tokens an agent/CI reads to re-verify a known flow, per run.** A
test suite's real job is the SAME verification over and over; that is the axis where Iris's
deterministic replay compounds against tools that must re-drive with an LLM every run. (`METRIC.md`)

## Where Iris stands (measured)

| Dimension                                                             | Iris                                            | Playwright MCP         | DevTools MCP | Honest verdict                                                                                                         |
| --------------------------------------------------------------------- | ----------------------------------------------- | ---------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------- |
| **Detection — Layer A** (10 scripted regressions, RCR gate)           | **RCR 1.0, VE 10.58**                           | RCR 0.9                | RCR 0.9      | Iris catches all; competitors miss 1 each. (`METRIC.md`, `PROGRESS.md`)                                                |
| **Detection — Layer B** (real gpt-4o agent loop, authoritative usage) | **5/5 @ ~55k tok**                              | 4/5 @ ~30k             | 3/5 @ ~32k   | Iris most accurate; ~1.7× tokens. (`LAYER-B.md`)                                                                       |
| **Regression-run cost — Layer C** (replay a known flow)               | **~175 tok, deterministic**                     | ~30,249 (LLM re-drive) | ~32,296      | **128–184× cheaper per run**, compounding. (`LAYER-B.md` Layer C)                                                      |
| **Regression detection — Layer C**                                    | selector 3/3, consequence 2/2 (green-but-wrong) | no replay              | no replay    | Iris-only: deterministic replay catches + names the fix.                                                               |
| **Hard: visual / computed-style / theme** (6 bugs)                    | 6/6                                             | 6/6                    | 6/6          | **Parity.** Any evaluate reads computed style; Iris's edge is ergonomic (native vs +117–259 JS tok). (`HARD-BENCH.md`) |
| **Hard: state/UI desync** (UI lies about the store)                   | **CAUGHT**                                      | missed                 | missed       | **Iris-only capability** — competitors have no path to app state. (`HARD-BENCH.md`)                                    |

## The one honest sentence

**Iris ties on anything a user can see in the DOM (with a real, growing cost/ergonomic advantage), and
wins outright where the bug requires seeing the program itself — its state, and the same flow run
again deterministically.** Not "Iris sees pixels better"; "Iris sees the program, and over repeated
runs it is two orders of magnitude cheaper."

- **Decisive wins:** regression-run cost (128–184×, compounding), and any bug whose truth lives in
  state the app never put in the DOM (UI-vs-store desync).
- **Ties (honest):** every visually-observable bug — computed style, geometry, occlusion, color,
  theme — is reachable by any tool with a JS-`evaluate`. Iris is more ergonomic (one native call, no
  JS authoring), not more capable.
- **Within-field 100× is real only on RRE** (repeated regression runs), not on single-shot detection
  (you can't catch 100× more than ~10 bugs). Stated so it can't be misread. (`METRIC.md`)

## Caveats (so the data isn't oversold)

- `o200k` is an OpenAI BPE proxy (≈ Anthropic text tokens ±~20%), except Layer B which uses
  authoritative model `usage`. Image-token comparisons vs screenshot agents are directional. (`MERMAID.md`, `METRIC.md`)
- Layer B is one model (gpt-4o), one turn budget, 5 scenarios; the token ratio is structural, accuracy could shift.
- The hard-bench competitor results were corrected for apparatus artifacts (MCP init timeout, a nav
  badge mismatch, result-parsing) before reporting — see `HARD-BENCH.md`. Three Iris bugs were fixed
  while building it (`iris_inspect` occlusion/cursor, `iris_state` validation, design-token `offTheme`).

## Reproduce

`pnpm bench` (deterministic Layer C, fast) · `pnpm bench:full` (+ Layer A) · `pnpm bench:gate`
(fail on regression vs the last `history.jsonl` row). Hard suite: `node bench/harness/hard-bench.mjs`
and `node bench/harness/hard-bench-state.mjs`. Layer B needs `OPENAI_API_KEY`/`ANTHROPIC_API_KEY`.
