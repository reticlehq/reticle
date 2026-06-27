# Competitive benchmark — Iris vs the browser-agent field

> Measured, reproducible comparison of Iris against the browser agents that claim **bug detection** or **token efficiency**. Every number here is produced by a script in `bench/harness/` (listed per section); nothing is hand-entered. Honest by design — the caveats and the cases where Iris _loses_ are included, because a benchmark you can't trust is worthless.

## TL;DR

- **Detection:** Iris is the only tool at **100%** on the injected-regression suite (10/10), 0 false positives. The cheapest tool (agent-browser) catches **72.7%** — cheap because it's blind.
- **Tokens:** in its recommended `hybrid` profile Iris is **competitive** with the MCP substrates on a full flow (and cheaper than Playwright MCP), not the leanest — agent-browser is leaner _by being blind_. Iris's real token win is the **regression loop: ~122 tokens/run** (deterministic replay) vs ~30k to re-drive with any LLM tool — **~248× per flow, ~4,172× at suite scale.**
- **Uniqueness:** no competitor combines **deterministic replay + app-signal assertions + a test harness** in one tool. The field is converging on record-once/replay, but all validate with shallow "non-empty/non-error" checks — **everyone can replay; only Iris verifies.**
- **Honest limits:** Iris is _blind to pure presentation/CSS bugs_ via signals (its opt-in visual-diff layer covers those); needs an embedded SDK (zero-config for DOM/network/console, ~20 one-line `iris.signal()` calls for the signal oracle); and is a verifier for _your_ app, not a web navigator.

---

## 1. Detection + observation cost (Layer A — 10 injected regressions)

Each tool drives the same app, observes, and must flag each regression. `run-observation.mjs` + `analyze.mjs`.

| Tool | Avg tokens/obs | Median | Detection | Missed | False positives |
| --- | --- | --- | --- | --- | --- |
| **Iris** | 815 | 735 | **100% (10/10)** | — | 0 |
| Playwright MCP | 1,268 | 1,294 | 90.9% | 1 | 0 |
| Chrome DevTools MCP | 758 | 1,031 | 81.8% | 2 | 0 |
| Playwright CLI (Microsoft) | 1,377 | 1,346 | 81.8% | 2 | 0 |
| agent-browser (Vercel) | **242** | **205** | 72.7% | 3 (all silent) | 0 |

**Silent-regression sub-score** (the bugs that render fine — KPI card removed, layout shift, broken validation): **Iris 3/3; Playwright MCP 2/3; DevTools 1/3; Playwright CLI 1/3; agent-browser 0/3.** Only Iris catches all three.

## 2. Full-flow token cost (model — `full-flow-token-model.mjs`)

Deterministic model: measured per-request tool-schema tax + measured per-step observation payloads, modelling the real quadratic history re-send over a 10-step flow, cached (realistic) policy. (Excludes agent reasoning/output ≈ tool-independent.)

| Tool                                    | Cached cumulative input (10 steps) |
| --------------------------------------- | ---------------------------------- |
| agent-browser                           | 2,973 (leanest — 72.7% detection)  |
| Playwright CLI                          | 19,663                             |
| **Iris (hybrid — recommended default)** | ~23,000                            |
| Chrome DevTools MCP                     | 24,622                             |
| Playwright MCP                          | 25,493                             |
| Iris (full — current default)           | 45,088                             |

> **Actionable:** Iris's _current_ default (`full`, 57 tools) carries a 16k-token schema tax — the highest of any tool — making it the most expensive on a full flow. The `hybrid` profile (14 tools, 5.7k schema, −64%) makes Iris cheaper than Playwright MCP **with no detection loss** (verified: 10/10 in `hybrid`) and flow-replay reachable via the `iris_run` meta-tool. See `schema-tax.mjs`.

| Profile        | Tools | Schema tokens | Detection oracles | Flow-replay    |
| -------------- | ----- | ------------- | ----------------- | -------------- |
| dynamic        | 2     | 256           | on-demand         | on-demand      |
| **hybrid**     | 14    | **5,748**     | direct            | via `iris_run` |
| core           | 12    | 5,583         | direct            | ✗ (no reach)   |
| standard       | 39    | 8,685         | direct            | direct         |
| full (default) | 57    | 16,014        | direct            | direct         |

## 3. Regression-run cost — the compounding win (`replay-bench.mjs`, `suite-rre.mjs`)

|                    | Iris (deterministic replay) | Competitor (LLM re-drive) | Ratio   |
| ------------------ | --------------------------- | ------------------------- | ------- |
| 1 flow / run       | **122 tok**                 | ~30,249 (Playwright MCP)  | ~248×   |
| 4-flow suite / run | **29 tok** (one verdict)    | ~120,996                  | ~4,172× |

`iris_flow_verify` returns one verdict for K flows → read-cost ~constant in K; competitors re-drive each flow with the LLM every run. The ratio compounds with suite size.

## 4. Multi-agent throughput (`multi-agent-throughput.mjs`)

One Chromium, N isolated leased contexts. 16 flows, each = real context+navigation + verify hold:

|                       | Serial (cap 1) | Pooled (cap 8)              |
| --------------------- | -------------- | --------------------------- |
| Wall-clock (16 flows) | ~35 s          | **~5.3 s**                  |
| Speedup               | —              | **6.66–6.78×** (reproduced) |

Tunable to 16 contexts; over-cap flows queue FIFO. No catalogued substrate competitor ships a local multi-agent context pool.

## 5. The oracle wedge — backend-contract regressions (`signal-vs-mock-bench.mjs`)

Four backend-contract regressions that render **pixel-identical** (dropped field, 200-with-wrong-body, pagination dup, auth-scope 403 silent-catch):

| Oracle                                 | Caught    |
| -------------------------------------- | --------- |
| Visual / DOM diff                      | **0 / 4** |
| Network-mock replay (Meticulous-style) | **0 / 4** |
| **Iris app-signal**                    | **4 / 4** |

Visual diff sees only pixels; a network-mock replays yesterday's response so the live backend change never reaches it (Meticulous's own words: "only catches frontend regressions"). Iris asserts on the live payload/signal.

## 6. Oracle-coverage — best-of-both (`oracle-coverage-bench.mjs`)

| Tool                                       | Backend-contract | Presentation / CSS | Classes |
| ------------------------------------------ | ---------------- | ------------------ | ------- |
| **Iris** (signal + visual diff)            | COVERED          | COVERED            | **2/2** |
| every substrate / Meticulous / Antigravity | BLIND            | COVERED            | 1/2     |

Iris carries both oracle families. _Honest:_ the signal oracle is blind to pure CSS bugs — Iris needs its visual layer there (it has it). The claim is **best-of-both coverage**, not "signals beat pixels."

## 7. Capability matrix

| Capability | Iris | PW MCP | DevTools MCP | agent-browser | PW CLI | Stagehand | Browser Use | Meticulous |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Bug detection (asserts) | ✅ signal | ✗ | diagnose | ✗ | ✗ | LLM-judge | LLM-judge | visual diff |
| Deterministic regression replay | ✅ | ✗ | ✗ | ✗ | ✗ | partial (selector cache) | ✗ (cached script) | ✅ |
| Multi-agent / local pool | ✅ | ✗ | ✗ | ✗ | ✗ | ☁️ paid | ☁️ | ✗ |
| Test harness / framework | ✅ vitest-native | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✅ SaaS |
| App-signal / state oracle | ✅ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ (mocks net) |
| Deterministic vs LLM | replay det. | det. driver | det. capture | LLM | LLM | hybrid | LLM | det. replay |

## Methodology, fairness, reproducibility

- One pinned demo app + a deterministic git-revert regression injector; tools driven by an identical scripted adapter (no LLM in Layer A) so the comparison is apples-to-apples.
- Tokens measured with the `o200k` tokenizer (labeled a proxy, not provider-billed). The **fully fair paid** full-flow benchmark (real model `usage`, N≥20, cached+uncached) is specced in `../plan/token-bench-methodology.md` and is the honest next step.
- CLI competitors invoked via pinned `npx`; their per-call latency is inflated by `npx` resolution and is **not** reported as their true latency (token numbers are unaffected).
- Caveats kept visible: detection cells from single deterministic runs; the multi-agent number reproduced within ~2%; the full-flow figures are a model, not a paid measurement.

Run it: `pnpm bench` (deterministic Layer C) · `pnpm bench:full` (+ Layer A) · `pnpm bench:gate`.
