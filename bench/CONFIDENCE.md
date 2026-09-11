# Confidence, per claim

A single "how confident are we" number would hide the only thing that matters: confidence is not uniform across what this library claims. Some of it is repeated and controlled, some is one run, and some is explicitly unmeasurable here. This table is what a confidence figure would be averaging over.

Every row is generated from an artifact on disk or names the run that produced it. **HIGH** means repeated and controlled. **MEDIUM** means measured once, or measured without a control. **LOW** means argued but not measured. **NONE** means we tried and could not.

> **Measured 2026-07-24 and not re-run since.** Confidence is a claim about evidence, and evidence has an age — a row that says "fresh" is only fresh relative to when somebody wrote it, which is the one thing an undated table cannot tell you. Anything here comparing Reticle to Playwright or DevTools was taken against `@playwright/mcp@0.0.76` / `chrome-devtools-mcp@1.3.0` and Reticle `0.8.0`; all three have moved. The deterministic replay rows are re-run often and are current — see the freshness banner in [`SCORECARD.md`](SCORECARD.md) for the values re-measured 2026-08-11.

## What Reticle claims

| # | Claim | Evidence | Confidence |
| --- | --- | --- | --- |
| 1 | Catches bugs a Playwright script misses | 88-bug registry: **86/88** vs 60/88; **26/26 critical vs 9/26**; 0 real bugs missed | **HIGH** — fresh full head-to-head, both harnesses re-run end to end after the harness defects were fixed |
| 2 | Does not flag healthy builds | 0 false positives on every clean variant, both runs; 2/2 false-positive traps held | **HIGH** — repeated |
| 3 | A failure names the file to open | 83/85 carry `file:line`; 79 name the exact file | **HIGH** — plus a control (0/22 with stamps stripped) proving the stamp causes it |
| 4 | That pointer is not obtainable another way | 0/5 recoverable via any other Reticle route, inspect included | **HIGH** — direct measurement, both conditions |
| 5 | It measurably reduces agent work | 22 → 12 tool calls (−45%), 6/6 fixed both conditions | **MEDIUM** — 3 bugs, 2 runs/cell, spread ±2. Scoped to a well-structured codebase |
| 6 | Adding the cause or a fix hint helps further | 10 and 11 tool calls vs 12 — inside the baseline's own spread | **NONE** — measured, does not resolve. Fix-hint surface deliberately not built |
| 7 | Instrumentation is affordable at scale | < 1.2 pp of main thread at 9,083 nodes; and drive-cost is FLAT across a 25× DOM increase (7,400 → 7,276 tok at 800 → 20,000 rows, every call ratio 1.00) | **HIGH** — three conditions for overhead; scaling measured on one app at three sizes |
| 12 | It does not leak memory, ports or processes | 8 sequential + 4-way concurrent: RSS flat (0 MB/session slope), 0 leaked ports, 0 surviving children, 8/8 concurrent sessions OK | **MEDIUM** — one machine, one run, 8 sessions. The daemon's own port persists BY DESIGN (detached, bounded by a 300 s idle self-shutdown) |
| 8 | The agent gets an exact answer at scale | `count_only` returns 4,016 exact in 62 bytes / 46 ms on a 4,000-match page | **HIGH** — measured live, and the bug it replaced (total tool failure) is fixed |
| 9 | Verdicts do not rest on evidence we lost | 5 false-green paths closed; each fix reverted against a good build to prove it goes red | **HIGH** for the five found. **MEDIUM** that no sixth exists |
| 10 | Concurrency | 6.78x pooled — but Playwright's own `newContext` gets 4.08x | **HIGH**, and it is _not_ a differentiator; the README says so |
| 11 | Works across frameworks | 15/15 e2e specs, bench-app + next-smoke | **MEDIUM** — restored this session after 4 had been dead; now guarded in the fast gate |

## What is NOT established

- **Fix-rate lift.** Row 5 measures agent WORK, not outcomes. Fix rate was 6/6 in both conditions — the pointer removed the search, it did not make the agent more capable. Nobody should quote a fix-rate improvement.
- **Magnitude on a badly-organised codebase.** Attempted twice in a package 10x the fixture (337 files): 5 and 9 tool calls. This repo is too well-named to produce a hard localization case. The literature's large numbers come from unfamiliar repos with weak naming, which is a property of the codebase and not something a bigger fixture here simulates.
- **In-page network fidelity in attach mode.** Reticle reads `init.body` inside its own fetch wrapper, so anything installed EARLIER sits below it and mutates after we have read. Fixed on the DRIVE path (CDP wire capture). On the ATTACH path it is now **declared** rather than silent — a `wrapped-network` blind spot fires at install and coverage reports partial. That does not restore fidelity; it stops a verdict implying we had it. Two heuristic limits are pinned by tests: a BOUND wrapper is missed, and a polyfilled fetch is reported (correctly, but it will read as a false positive).
- **The regression-cost denominator.** The "128–2574× cheaper per run" replay claim divides by an LLM re-driving Playwright-MCP (`suite-rre.mjs` hardcodes ~30,249 tok/flow), not by `npx playwright test`. A compiled suite a team already owns re-runs for **zero** tokens, and a live head-to-head (`harness/compiled-suite-vs-replay.mjs`, 4 flows, no LLM either side) showed the compiled suite _faster_ wall-time. Reticle's replay value is consequence oracles + record-by-driving + 0% flake — not token savings against an existing suite. Do not quote the multiple against compiled suites.
- ~~Silent whole-store truncation.~~ **FIXED.** Both the whole-store and scoped reads now carry a `truncation` block counting dropped items and placeholder replacements, present only when a cap actually fired, so an intact read is byte-identical and the field's presence is the warning.
- **TESTIDS drift.** Nothing keeps `registerCapabilities` TESTIDS in sync with the DOM: bench-app's array was byte-identical for ~17 days while 43 new `data-testid` lines landed (3 listed ids can never exist; 28+ real ids unlisted; next-smoke 33% coverage). Drift degrades _discovery_ only — an unlisted testid is still fully actionable — but no check or codegen exists to catch it.
- **That the false-green list is complete.** Five were found by auditing for one bug's _shape_. The audit found them; it cannot prove there is no sixth.
- **Speed: Playwright is FASTER, 2.4 s vs our 3.6 s per bug.** The old "10× faster" figure was a harness artifact — a diagnostic string built eagerly on every run containing an `innerText` read of an element that only exists after a failed login, so all 170 runs paid Playwright's 30 s default. Built lazily, the honest gap inverts. We cost roughly HALF the output bytes (4.0 KB vs 8.2 KB, after the observe-filter fix took us from 9.97 KB) and about 1.5× the wall-clock. Anyone still quoting 10× is quoting a bug in our own harness.
- **The MCP schema tax — now a WIN, having started as the sharpest criticism.** Measured live, all servers one run: our default is **2,832 tok** vs playwright-mcp 3,725 and chrome-devtools-mcp 5,116 — **0.76× the incumbent**, i.e. cheaper. It began this build at 9,797 (2.63×); a compact predicate took it to 6,559, then dropping the advertised outputSchema on lean profiles took it below Playwright. The typed object still travels as `structuredContent` (verified live + a pinned SDK test); only optional client-side validation is dropped. Our `dynamic` profile is 282 tok, 13× cheaper than Playwright. Artifact: `bench/raw/schema-tax.json`.

## The honest summary

The strongest claims are 1–4 and 7–8: detection, honesty on clean builds, localization, and behaviour at scale. Those are repeated, controlled, and several are backed by a deliberate attempt to break them.

The weakest is 5 — the one people will most want to quote. It is three bugs on a small, tidy codebase. It is real, it is controlled, and it is small.

And row 6 is the one worth reading twice: **a planned feature was measured and dropped.** That is the posture this table is meant to preserve. A benchmark whose only function is to justify what was already going to be built is not a benchmark.
