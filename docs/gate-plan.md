---
title: Release gate plan
description: 'What has to be true before a PR merges and before a release ships, and what is built so far.'
icon: list-check
---

Two gates, not one: a **merge gate** that answers "does this PR break anything" and runs on every PR in minutes, and a **release gate** that answers "does this version work in the clients people use" and runs on a release candidate over hours. Phases 0, 1, 2 and 4 are built; Phase 3 (the client matrix) is blocked on `init` learning each client, and Tier 2 is blocked on a token that cannot be created from inside this repo.

> What has to be true before a PR merges and before a release ships, why each piece exists, and what is built so far. Derived from [`system-map.md`](./system-map.md); the harness rules every tier obeys are in [`harness-rules.md`](../apps/e2e/harness-rules.md).

## Two gates, not one

|         | Merge gate                   | Release gate                                      |
| ------- | ---------------------------- | ------------------------------------------------- |
| Answers | does this PR break anything? | does this version work in the clients people use? |
| Runs    | every PR                     | on a release candidate                            |
| Who     | machines only                | machines + humans                                 |
| Budget  | minutes                      | hours                                             |

**They must stay separate.** A merge that waits on a human client matrix stalls every contribution until three people with three editors happen to be awake.

## Tiers

| Tier | Question | Who | When | Blocks |
| --- | --- | --- | --- | --- |
| 0: repo | is the code internally consistent | Actions | every PR | merge |
| 1: install | does it install into an app nobody instrumented | Actions, scaffolded apps | PRs touching install/wire | merge |
| 2: ecosystem | does it survive third-party apps at real scale | `reticle-fixtures`, dispatch | 3×/week + release | release |
| 3: conformance | does each MCP client actually work | humans + headless CLIs | release candidate | the tag |
| 4: canary | does a real model still succeed | nightly, live LLM | nightly | nothing (alerts) |

**Tier 1 vs 2.** Tier 1 scaffolds a pristine app at CI time (`npm create vite`): clean by construction, seconds to produce, catches install _regressions_, fast enough to block a PR. Tier 2 uses vendored production apps and catches install _complexity_. Conflating them produces a gate too slow to block and too shallow to trust.

**Tier 3 is the [CNCF conformance](https://github.com/cncf/k8s-conformance) model:** contributors do not _claim_ a client works, they run one command and submit its machine-generated output as a PR, which a bot validates before a human looks. Self-reported pass/fail cannot gate anything.

**No LLM in the merge path.** Deterministic tests on every commit; live-model evals nightly and alert-only. The `record → save → verify → heal` chain is what makes this possible: a flow is recorded once by an agent, then replayed forever with no model.

## The matrix, factored

3 OS × 6 clients × 8 frameworks × 2 runtimes = 288 combinations. Nobody runs that. Test each axis against a fixed baseline of the others instead: 3 + 6 + 8 + 2 = **19 runs, plus ~4 deliberately chosen full-stack combos** where axis interaction is most likely (Windows+Cursor+Next, macOS+Claude Code+Tauri, …). Publish the factoring, and say plainly which interactions are untested.

## Phases

### Phase 0: the harness contract and the map (**done**)

Nothing below is trustworthy until a gate result can be distinguished from a gate artifact.

- [x] `docs/system-map.md`: topology, connection sequence, tool graph, fragility inventory
- [x] `apps/e2e/harness-rules.md`: the four rules, with the incidents that produced each
- [x] `apps/e2e/gate-harness.mjs`: the rules as code, `portHolders`, `freePortSafely`, `startOwnedDaemon`, `watchTransport`, `attributeOutcome`, plus a self-check
- [x] `run.mjs` and `ci.yml` no longer kill client sockets on the bridge port

### Phase 1: close the silent gaps already in reach

- [x] **Trace-shape assertions**: `apps/e2e/trace-shape.mjs` + `trace-shape-test`. One root span per callId, no nested span without a completed parent (the hang signature), no undeclared parentless `browser.command`, no `ok:false` without an error. Calibrated against a real 494-span run: silent there, fires on all four fault shapes.
- [x] **Daemon truthfulness (the port half)**: `daemon/port-presence.ts` gives a three-state answer (`daemon` / `foreign` / `free`) from two probes and no platform code. `serve` now refuses a foreign port and waits for a real bind before claiming success; `status` and `doctor` name the obstacle. Guarded by `daemon-port-honesty-test`, which squats the port and includes the free-port control. (#105, #112, #115)
- [x] **`daemon_alive` heartbeat**: `daemon/heartbeat.ts` beats unconditionally on a fixed cadence (30s, `RETICLE_HEARTBEAT_MS` to override) and `classifyDaemonLife` reads a log back into `alive` / `clean` / `signalled` / `died_silently` / `unknown`. A heartbeat nobody interprets is only log volume, so the reader ships with it and is exported for the gate. Guarded by `daemon-heartbeat-test`, which SIGKILLs a real daemon and includes the tidy-shutdown control. (#123)
- [x] **`observation_lost`**: a new `VerifiedReason`, matched above the `pass === false` clause, so a lost connection grades UNKNOWN instead of being reported as a failed assertion. Signalled by a structured flag from `waitForPredicate`, never by matching on `failureReason` (which is free prose about the app everywhere else it is produced). Threaded through the assert and wait paths too, not just act. (#124)
- [x] **Telemetry chokepoint coverage**: `tools/dispatch-chokepoint.test.ts` scans for any `.handler(` call outside `runTool` and fails unless it is declared with a stated reason and cost. Three exist today: family folding in `merge-tools.ts` (counted as the family, not the member), `verify-change-tools.ts` (inner `flow_verify` uncounted), and the bridge test harness. Two of those are known observability gaps; the value is that they are now _known_ and a fourth cannot arrive unnoticed. Verified by introducing a bypass and watching it redden.
- [x] **Specified transport faults** in place of `kill -9`: `apps/e2e/fault-proxy.mjs` (no dependency; toxiproxy is not installed and the battery is deliberately dependency-free) gives none / reset-peer / blackhole / latency / truncate over `node:net`, each proven distinguishable by its own self-check. `transport-faults-test` puts it between the MCP proxy and a real daemon and asserts the product claim: every call is ANSWERED and the stdio server survives. It also separates the two unanswered-call populations by timing: a queued call answered by the 20s queue timer, a call broken in flight answered in ~600ms via `sse_aborted`. A toxic breaks the connection and never the process, so the self-inflicted `kill -9` confusion is unreachable here.

### Phase 2: the install gate

- [x] **Tier 1, all three `init` paths**: `apps/e2e/install-gate.mjs` (`pnpm gate:install`), wired into CI as its own `install-gate` job. Scaffolds `npm create vite`, `create-next-app` (app router) and `create-next-app --no-app` (pages router), publishes this checkout to a local Verdaccio, lets **`init` do its own dependency install** from it, boots each app, opens it in a real browser and POLLS for a session. **3/3 scaffolds, 8/8 assertions each.** The pages-router path (no `app/` root layout, so connect must mount via `pages/_app`) is the one that once did nothing at all, silently.
  - `⚠` is an absolute zero, not a tolerated exemption. The earlier `file:`-wired version had to pass `--no-install` and then argue away the `⚠` it produced, which left the step most likely to regress as the one step untested.
  - A `package-lock.json` check confirms the SDK came from the local registry. Without it a scope typo silently measures PUBLISHED code, which is exactly the defect this work found in `docs/local-registry.md` (`@reticle:` vs `@reticlehq:`).
  - **Negative control, run FIRST in CI** (`pnpm gate:install:self-test`): every scaffold is mis-wired to a port the daemon is not on and every one must go RED. Verified: all three fail on the session assertion alone (7 passed, 1 failed), attributed FAIL rather than INCONCLUSIVE because the bridge was provably up. A guard that has never failed is not a guard.
  - `file:` wiring is a dead end and the reason is worth keeping: npm symlinks it, which Vite resolves and Next does not; `--install-links` copies instead and then cannot resolve `workspace:*` at all.
- [◐] **Tier 2: built, NOT live.** The sending half is `fixtures-dispatch` in `ci.yml` (on `main` only, never fails the workflow; it is a notification, and the verdict lands in the fixtures repo's run). The receiving half is a template at [`docs/fixtures-dispatch-receiver.yml`](./fixtures-dispatch-receiver.yml), kept in the _sending_ repo so the two ends of the contract cannot drift apart.
  - **Blocked on two things neither of which can be done from inside this repo:** a fine-grained PAT with Actions:write on `reticle-fixtures` added as `FIXTURES_DISPATCH_TOKEN`, and the template copied into that repo. Until the token exists the job says so and exits 0.
  - **It has never run.** Every line is unverified. Tier 2 appearing in this plan is not Tier 2 being live, and the checkbox is deliberately ◐ rather than ✗ or ✓.
- [x] **Committed baseline of what `init` plans**: `apps/e2e/install-baseline.json`, one line per step (`mark title → target`) per scaffold, diffed on every run; `--update-baseline` re-records it so a change arrives as a reviewable diff. "Zero ⚠" is an absolute and cannot carry this alone: a step silently changing mark (`✓ → ℹ`) still passes it, and a step DISAPPEARING from the plan passes it most comfortably of all, because the thing that would have warned you is the thing that is gone. A threshold answers "is this bad"; a baseline answers "is this DIFFERENT", and silent regressions are almost always the second question.
  - The `target` is in the fingerprint and is the load-bearing field. Leaving it out (which the first version did, on an assumption about absolute paths that was simply wrong) made the app-router and pages-router baselines byte-identical, so a regression mounting the pages-router app into the wrong file would have diffed clean. `Mount ReticleDev → app/layout.tsx` vs `→ pages/_app.tsx` is the whole distinction.
  - Proven by tampering: changing one committed entry to `vite.config.js` reddens with a readable expected/got, while every other assertion stays green, which is the point, since a one-character target change is invisible to both "zero ⚠" and "a session appeared".
- [x] **Risk routing**: a `changes` job computes the diff with plain `git diff --name-only` (no third-party action: the question is "what changed", and a paths-filter dependency for a one-line diff is a supply-chain decision for nothing) and gates `install-gate` on it. It **fails open**: an unresolvable base ref runs every tier, because the cost of a false positive is CI time and the cost of a false negative is the 0%-connect class shipping again.
  - The reason this was deferred is now solved rather than ignored: a job skipped by an `if:` reports **skipped**, and a branch-protection rule requiring `install-gate` directly would block every docs-only PR forever, waiting on a job that will never run. So nothing is required directly: a single aggregate `gate` job is, and it passes when every dependency succeeded **or was deliberately skipped**, and fails on anything else. `always()` on that job is load-bearing; without it the aggregate is itself skipped whenever a dependency is, reproducing the problem one level up.
  - Routing verified against twelve representative paths without touching CI.

### Phase 3: the client matrix

**Blocked on `init` learning each client.** Today only Claude Code (`claude mcp add`) and Cursor (`~/.cursor/mcp.json`) are first-class; everything else gets a printed JSON snippet, so a per-client release artifact would measure the contributor's copy-paste rather than the product.

- [x] **`init` support per client**: `init/mcp-clients.ts` registers Reticle with **seven** clients, not two. Every path and shape was read from that client's own documentation rather than recalled: Cursor/Windsurf/Gemini share `mcpServers`, VS Code uses `servers`, OpenCode uses `mcp` with the command as an **array**, Codex is TOML. A single "write mcp.json" assuming the Cursor shape produces a file three of them ignore: an install that reports success and registers nothing.
  - Detection is conservative and one-directional: we write into a config a client **already has**, never creating `~/.gemini` or `~/.codeium` for somebody who does not use them.
  - Codex is deliberately not auto-written. Editing TOML without a parser risks every _other_ server in the user's file; it returns MANUAL with an exact block.
- [x] **Per-client compat script**: `apps/e2e/client-compat.mjs`. Extracts the command from the config **exactly the way that client would**, runs it, and speaks MCP to it. 7/7 clients, 23 assertions, each advertising the default surface (the count is asserted in `surface-sizes.test.ts`, never restated here).
  - It proves only the half a machine can prove, and the verdict is named `runnable-unverified` so the distinction survives into the matrix. Whether the client _reads_ that path needs the real client, which is the submitted half.
- [x] **Submission flow**: `apps/e2e/matrix.mjs --validate`, run by CI's `matrix-records` job on every PR. The validator refuses what cannot be acted on: `works` without `checks.toolsVisible` (the self-report the flow exists to replace), `broken` without the client's verbatim error, or any record with no host or version. Its self-check runs first, because a validator that has never refused anything is not a validator. Contributor guide in [`docs/matrix/README.md`](./matrix/README.md).
- [x] **Generated `MATRIX.md`**: built from submitted records, prettier-ignored because a generated file that fails `format:check` teaches people to skip the gate. **The current honest state is seven clients and ZERO ticks**: `◐` means a runnable entry was written where the client documents it and _nobody has run that client_, and the generated legend says so rather than rounding `◐` up to `✅`.

### Phase 4: rates, not booleans

Connection stability is a rate. A pass/fail cannot express "breaks a lot", and a number that is not recorded cannot regress.

- [x] **Soak with a recorded stability rate**: `apps/e2e/soak.mjs` (`pnpm gate:soak`), run inside the e2e battery where a paired app already exists, and appended to `bench/soak-history.jsonl` so the rate can regress against itself. One held-open MCP link for the whole run, never a reconnect per call (harness rule 3). First recorded row: **120/120 answered, 0 link drops over 39s**.
  - **Idle time between rounds is the point**, not a pause for politeness. 150 back-to-back calls finish in seconds and measure throughput; the disconnect users actually report happens while nobody is calling: the agent is thinking and the next call finds the link gone. Keep-alives, idle shutdown and proxy timeouts all live in that gap, so a soak with no idle never enters it. `--idle-ms 30000 --rounds 60` is the half-hour release soak.
  - Attribution is 3-valued: a transport that did not stay up reports INCONCLUSIVE and claims nothing about the product (harness rule 4).
- [x] **Per-tool latency and failure budgets**, same run, `bench/TOOL-PROFILE.md`. Answers "which tool is breaking": `tool-surface-sweep` proves each tool is callable **once**, and one call cannot have a failure rate.
  - **Latency is recorded, NOT gated, and that is a deliberate deviation from the wording of this plan.** CLAUDE.md: timing assertions are a bug. A p95 budget in wall-clock ms is a statement about the machine, goes red only under parallel CI load, and teaches everyone to re-run; a gate people re-run has stopped working. A >4x p95 jump prints a loud WARN instead. What IS gated: answer rate (absolute) and per-tool failure rate (vs the recorded baseline), both deterministic.
  - The warn carries a 50ms floor, added because the first real run shouted `reticle_sessions p95 8ms vs 1ms (>4x)`: true, imperceptible, and exactly how a warning channel dies.
  - It profiles the **6 repeatable read-only tools, not all 48 advertised**, and says so in the generated file. Repeating a mutating tool measures the fixture drifting rather than the tool degrading.
  - Eleven-case self-check (`node apps/e2e/soak.mjs --self-check`), in CI's `matrix-records` job. It needs no build and no app, proven by running it in an empty directory, which is how a static import of the built CLI was caught.
- [ ] false-green scorecard as a standing gate against apps we did not write (#130)
  - **Genuinely blocked here, not deferred by choice.** "Apps we did not write" is the whole content of the check, and this repo contains only apps we wrote. It belongs to the fixtures repo (Tier 2) and needs `FIXTURES_DISPATCH_TOKEN`.
