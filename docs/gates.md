---
title: Gates
description: 'I changed some files. Which command do I run before I push?'
icon: shield-check
---

If you changed anything at all, run `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test:unit` (about two minutes). If you also touched the tool surface, install, desktop or Rust, section 1 below names the one extra command your change needs. CI runs everything regardless, so routing costs you a slower red, never a missed one.

> **One question this file answers:** _I changed some files. Which command do I run?_
>
> The _why_ behind the gate design (tiers, the merge-gate/release-gate split, what is still unbuilt) lives in [`gate-plan.md`](./gate-plan.md). This file is the routing table.

---

## 0. Last verified

Every gate below was executed end to end against `main` on **2026-08-12** (macOS, M-series, `v2.6.0`). A green row means somebody watched it go green, not that it is supposed to be green.

**Rows marked ↻ were re-measured on 2026-09-09** (macOS, M-series, this branch). The numbers they replace were wrong by a lot, and wrong in the way that is hardest to notice: `test:unit` was recorded here as "5,725 tests / 613 files" and, forty lines further down in the same file, as "4,315 tests". Two copies of one number, neither derived from anything. The battery was 33 in one row and 32 in another, against 38 spec files on disk.

A ↻ row's COUNT was re-derived; a ↻ row's ✅ is still the August sweep unless the row says otherwise. `test:unit` was actually re-run (`turbo run test:unit test:guards --force`, then `pnpm test:bench`, summed from vitest's own per-package output). The battery's spec count was recounted from `ORDER` and `DESKTOP` in `apps/e2e/run.mjs` cross-checked against `ls apps/e2e/specs`; **it was not re-run**, so its ✅ and its wall clock are still August's.

| Gate | Result | Wall clock |
| --- | --- | --- |
| `pnpm build` | ✅ | ~40s |
| `pnpm lint` (+ both guard self-tests) | ✅ | ~15s |
| `pnpm typecheck` | ✅ | ~10s |
| ↻ `pnpm test:unit` | ✅ **9,210 tests / 934 files** across 10 packages plus the bench harness | ~70s |
| `pnpm format:check` | ✅ | ~10s |
| `pnpm test:integration` | ✅ **14/14**, re-measured 2026-09-11 | 17s |
| ↻ `pnpm test:e2e` | ✅ **39/39 specs, 334 checks**, re-measured 2026-09-11 | **490s** (Aug) |
| `pnpm test:e2e:desktop` | ✅ **3/3** (Electron 22, electron-vite 6, Tauri 17), 2026-09-11; see the Tauri note below | 58s |
| `node apps/e2e/soak.mjs --self-check` | ✅ | `<1s` |
| `node apps/e2e/matrix.mjs --self-check` | ✅ | `<1s` |
| `pnpm matrix:compat --only cursor` | ✅ 4/4 | ~10s |
| `pnpm bench` | ✅ 10/10 (**was failing before this sweep**, see below) | 279s |

**`pnpm bench` was broken and nobody knew.** `suite-rre.mjs` recorded four flows that asserted no observable consequence and then demanded a `pass` verdict from whole-suite replay, which correctly grades an assertion-free suite `unverifiable`. The product got more honest about false greens; the benchmark measuring it did not follow, so the whole run aborted at script 9 of 10 and `replay-determinism` never ran at all. Each flow now carries a success oracle.

That paragraph used to end "**nothing in CI runs it**, so it can only rot silently", and it is left here because it is the reason the `bench` job below exists. It is no longer true: `ci.yml` has a `bench` job that runs `pnpm bench:full` then `pnpm bench:gate`, path-routed on the files that can move token cost. What is still true is the narrower claim in section 4: `bench/` as a whole is measurement, and only the replay + observation-cost numbers are gated.

**`pnpm gate:install` was run on 2026-09-11 and passed 10/10 scaffolds**, which is a stronger claim than this paragraph used to make. It matters this release because `pnpm -r publish` selects **thirteen** packages and two of them gained a `prepack` during v3; the gate is the only thing that runs those prepacks against a real registry.

The Windows and Rust jobs are still **not** run here: they are CI-only. They are green on `main` per the last CI run, which is a weaker claim than every row above and is stated that way on purpose.

**The Tauri spec is FLAKY on macOS, not broken.** Measured 2026-09-11 over six runs: three failed and three passed, standalone and in-battery alike. When it succeeds the boot IPC arrives in under 200ms against an 8000ms budget, so the failure is all-or-nothing rather than slow, and raising the timeout is not the fix. CI runs Tauri on Linux under WebKitGTK, where it is green. Re-run before blaming a diff.

---

## 1. The routing table

Find the row that matches what you changed. Run its commands. That is the whole rule.

| You changed | Run | Cost |
| --- | --- | --- |
| **Anything at all** | `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test:unit` | ~2 min |
| The tool surface, the wire contract (`packages/core`), or an observer | ↑ **and** `pnpm test:e2e` | +~8 min |
| `reticle init`, `@reticlehq/vite-plugin`, `@reticlehq/next`, `@reticlehq/babel-plugin`, anything a user runs before their first session | ↑ **and** `pnpm gate:install` | +~15 min |
| `@reticlehq/electron`, `packages/tauri`, the IPC observer, desktop capture | ↑ **and** `pnpm test:e2e:desktop` | +~3 min |
| `@reticlehq/openreality`, the adjudicator, `WebRealm`, or anything a verdict is derived from | ↑ **and** `pnpm gate:conformance` | +~3 min |
| Telemetry, feedback, or anything that emits an event | ↑ **and** read [`telemetry-contract.md`](./telemetry-contract.md) first. `pnpm test:e2e` covers it (`telemetry-events-test`) | n/a |
| `packages/tauri` (Rust) | ↑ **and** `cd packages/tauri && cargo fmt --check && cargo clippy --all-targets -- -D warnings` | +~2 min |
| Docs, README, comments only | `pnpm format:check` | seconds |

**Why routing exists.** The full set is roughly 35 minutes. A gate people resent is a gate people route around, so only the tier that can see your change is worth your time.

**CI routes too, so this table is not just about your time.** It used to be true that CI ran everything regardless, which made skipping a local gate cost you nothing but a slower red. That is no longer so: the expensive gates only run when a path they care about changed, on the same reasoning as the table above. Machine time spent proving that a documentation edit did not break an Electron app is machine time nobody reads the result of.

Which means a gate skipped locally can also be skipped in CI, if what you changed did not match its paths. The routing is deliberately generous, and the paths are checked (`server/src/ci-routing-paths.test.ts` fails if a path in the workflow matches no real file, so a rename cannot quietly switch a gate off). But if you are doing something the paths would not predict, run the gate rather than assuming.

| CI gate | runs when |
| --- | --- |
| `verify` (format, lint, types, unit tests) | always |
| `windows`, `macos` | always, but only a narrow platform-sensitive slice of the tests |
| `rust` (Linux) | always. It is the only job in CI that compiles `packages/tauri` at all, so a skip would be a real hole |
| `rust-macos` | only when the Rust crate changed. A second opinion on the same crate, on a runner that bills at ten times the rate |
| `install-gate` | only when something a user runs before their first session changed |
| the install gate's self-test | only when the gate's own machinery changed, or on a push to main. It proves the gate can still fail, and that only changes when the gate changes |
| `desktop-e2e` | only when desktop code changed |
| `bench` | only when something that could move the numbers changed |

---

## 2. Every gate, and what each one can actually see

Each gate exists because the ones above it are blind to something. That blindness is the column that matters.

| Gate | Command | Proves | Blind to | CI job |
| --- | --- | --- | --- | --- |
| **Build** | `pnpm build` | every package compiles and emits | anything at runtime | `verify` |
| **Lint** | `pnpm lint` | style rules, plus the dependency-boundary and lossy-transform guards | anything not expressible as a rule | `verify` |
| **Typecheck** | `pnpm typecheck` | types agree across package boundaries | runtime behaviour | `verify` |
| **Unit** | `pnpm test:unit` | 9,210 tests, per-package, no browser | anything crossing a package boundary at runtime | `verify` |
| **Repo guards** | `turbo run test:guards` | the 42 `@reticlehq/server` tests that scan OTHER trees (docs, `apps/`, `bench/`, the workflows, the skills), held apart from the unit suite so the wide cache key is 2 seconds rather than 40 | anything inside a package | `verify` (inside `pnpm test:unit`) |
| **Format** | `pnpm format:check` | Prettier | n/a | `verify` |
| **Integration** | `pnpm test:integration` | real headless Chromium: browser pool, crash isolation, framework adapters, `withReticle` | the MCP surface, the daemon | `e2e` |
| **Web e2e battery** | `pnpm test:e2e` | **39** specs against 3 booted servers and a real browser (the tool surface, the daemon lifecycle, transport faults, telemetry, trace shape), plus the soak | desktop runtimes; the install | `e2e` |
| **Desktop battery** | `pnpm test:e2e:desktop` | two real Electron main processes (plain Vite + electron-vite) and a **packaged** Tauri binary, driven headless | web-only paths | `desktop-e2e` |
| **Conformance** | `pnpm gate:conformance` | drives the published specification's scenarios against this implementation on a real browser AND a real Electron shell, scoring every verdict through the spec's own `adjudicate` rather than Reticle's kernel | the seven scenarios no fixture can plant, reported ABSENT, plus the four above the claimed profile, reported `not asked` | ~5 min; runs in CI as the `conformance` job, path-routed on the protocol, the suite, the realm and the two fixture apps |
| **Install gate** | `pnpm gate:install` | scaffolds **10** pristine apps across 2 OSes (20 cells), publishes this checkout to a local Verdaccio, lets `init` install itself, boots each app in a real browser, polls for a session that advertised capabilities | install _complexity_; see [`fixtures.md`](./fixtures.md) | `install-gate` |
| **Matrix records** | `pnpm matrix:validate` | every submitted client-compat record is well-formed | whether the client actually works | `matrix-records` |
| **Windows** | (CI only) | that the code runs at all on the majority platform | e2e; Windows is unit-only | `windows` |
| **macOS** | (CI only) | the POSIX-but-not-Linux surface (paths, spawn, `lsof`, temp/state dirs) plus a real daemon's lifecycle | everything Linux already covers; it deliberately no longer re-runs the unit tier at a 10x billing multiplier | `macos` |
| **Rust** | `cargo fmt/clippy/check` | `packages/tauri` compiles and lints on Linux, macOS, and cross-checks Windows | everything JS | `rust` (always), `rust-macos` (only when Rust changes) |

**The single required status check is `gate`.** It passes when every job above either succeeded or was deliberately skipped by path routing, and fails on anything else. Adding a job to `ci.yml` is half the work; adding it to `gate`'s `needs:` list is the other half. A job missing from that list runs, reports, and is structurally incapable of blocking a merge.

### Guards that self-test

Four checks prove they can still fail before they are trusted. A guard that has never refused anything is not a guard, so each has a negative control that CI runs **first**:

```bash
node scripts/check-boundaries.mjs --self-test        # catches a synthetic bad dependency graph
node scripts/check-lossy-transforms.mjs --self-test  # catches an unclassified lossy export
node apps/e2e/soak.mjs --self-check                  # the soak gate still reddens on an unanswered call
node apps/e2e/matrix.mjs --self-check                # the validator still refuses a malformed record
pnpm gate:install:self-test                          # mis-wires every scaffold; the gate MUST go red
```

---

## 3. Gates that are not automatic

These are real and they work; they are not on the PR path, so they only run when somebody runs them.

| Command | What it is | When |
| --- | --- | --- |
| `pnpm gate:soak:record` | the half-hour release soak (20 rounds, 2s idle), re-records `bench/soak-history.jsonl` and `bench/TOOL-PROFILE.md` | before a release |
| `pnpm matrix:compat` | drives each MCP client's config exactly the way that client would; writes a machine record for `docs/matrix/` | before a release, per client |
| `pnpm knip` | unused files, exports, and dependencies | when the repo feels heavy |
| `node scripts/verify.mjs` in the sibling **`reticle-fixtures`** repo | installs this commit into nine real third-party apps (install _complexity_, not regressions) | see [`fixtures.md`](./fixtures.md) |

---

## 4. `bench/` is not a gate

`bench/` is **measurement and research**. Most of it blocks nothing and is allowed to bit-rot in a way a gate is not. But "nothing runs in CI" is no longer true, and was left standing here for a release after it stopped being: `ci.yml` has a `bench` job, gated on `changes.bench`, that runs `pnpm bench:full` and then `pnpm bench:gate`. It is the only thing in CI that measures TOKEN COST, which is how a release once shipped a measurable token regression with every other gate green. Read [`bench/README.md`](../bench/README.md) before touching it: it says which scripts are live and which are one-off studies kept as evidence for a published claim.

The one exception worth knowing: `pnpm bench` + `pnpm bench:gate` is a working regression gate for the replay numbers, and it is run by hand before a release.

---

## 5. When a gate fails and you think it is the gate's fault

Sometimes it is. The specific failures worth recognising:

- **`EADDRINUSE` / "died during boot".** A previous run left something on `:8787`, `:4310`, or `:3100`. `run-ci.sh` frees these on exit; if it was killed, free them by hand.
- **Killing port 4400 with `lsof -ti tcp:4400 | xargs kill -9`.** This SIGKILLs the `reticle mcp` proxy too, because the proxy holds a _client_ socket on the bridge port. Always add `-sTCP:LISTEN`. This is the root cause of most "the MCP went down" reports.
- **A timing assertion.** If a test asserts `Date.now() - t < N`, that is a bug in the test, not a flake to re-run. Assert the bound (output size, a truncation flag), or use a generous per-test timeout. See [`harness-rules.md`](../apps/e2e/harness-rules.md).
- **An `INCONCLUSIVE` verdict.** The harness is telling you the transport did not stay up, so it is claiming nothing about the product. That is the harness working, not the product failing.

The four rules every tier obeys, and the incident behind each, are in [`apps/e2e/harness-rules.md`](../apps/e2e/harness-rules.md).

## Reorganising a directory

A directory with a long flat listing is a symptom, not a defect. What says whether it is badly organised is the number of directory pairs that reach for **each other** -- those cannot be read, moved or tested apart -- and `server/src/directory-reach.test.ts` already tracks it.

So a grouping is an improvement only if that number stays flat. Check before you move:

```
node scripts/safe-to-group.mjs server/src/surface/tools query-shape snapshot-delta
```

It answers SAFE or UNSAFE by the same rule the test uses: a group is unsafe exactly when some directory it reaches out to also reaches back into it. It is a prediction; the test decides.

Two rules learned the expensive way:

- **Move only files that import no sibling.** A group containing something that imports back into its old home creates a mutual pair with its own parent.
- **Six registries key on a source PATH, and a move breaks them silently.** They are correct and useful individually; together they are a class, and the class was discovered one move at a time. Grep for the file you are moving before you move it. In the order they were found:

  | Registry                         | What it holds                                    |
  | -------------------------------- | ------------------------------------------------ |
  | `dispatch-attribution.test.ts`   | files allowed to dispatch an ACT                 |
  | `library-path-boundary.test.ts`  | declared crossings into the install-time surface |
  | `on-disk-versions.test.ts`       | every versioned on-disk format                   |
  | `orphan-modules.test.ts`         | modules with no production importer, and why     |
  | `config-search-depth.test.ts`    | the config walkers, opened by path               |
  | `presenter-dead-exports.test.ts` | retired artwork that must stay out of the bundle |

  A general guard was attempted and abandoned: a path in a string cannot be told apart from a fixture filename or an output path without guessing, and the noisy version of this check is worse than none: it would be switched off inside a week and take real coverage with it.

- **Being a leaf among siblings is not enough.** A file can import no sibling and still close a cycle once its directory has a name -- `tool-kit.ts` imports no sibling and reaches `flows`, and `flows` reaches back. Invisible while both sat in one directory.

## Why the conformance gate is not inside a battery

`pnpm gate:conformance` runs on its own rather than as a spec in `pnpm test:e2e`, and the reason is worth stating so nobody "tidies" it in:

- **The web battery boots the demo API with `REFLECT_MS=6000`.** The conformance runner boots its own on the same port. Folded into the battery it would find the battery's backend already answering, score every scenario against a deliberately-slowed API, and still print a number. A verdict suite silently measuring a different system is the exact failure it exists to catch.
- **It gates REGRESSION, not the score.** `earned` is `none` and stays `none` until the fixture grows: half the scenarios have no plant on any subject here, and ABSENT is never a pass. `--gate` fails only when a scenario that _could_ be planted was driven and answered wrongly. That number is zero today, so the gate is clearable; gating on `earned` would be a red board nobody can clear.

It **runs in CI** as the `conformance` job, path-routed on the protocol, the suite, the realm, the two functions in `core` that build a protocol subject, and the two fixture apps the scenarios are planted into. That is a narrower question than "could the desktop battery break", so it has its own filter rather than borrowing one. It is in the `gate` aggregate, so it can actually stop a merge.

It is a separate job rather than a step inside `e2e` for two reasons. That job boots the demo API with `REFLECT_MS=6000`, so a conformance run beside it would score every scenario against a deliberately-slowed backend while still printing a number. Both also want port 8787. It stays cheap despite driving Electron, because the desktop half needs a display and **not** Rust: it drives `apps/electron-smoke`, not the packaged Tauri binary that makes `desktop-e2e` the slowest job in the file.

Run it by hand too when you touch the protocol, the adjudicator, or anything a verdict is derived from; the path filter is a routing decision, not a definition of what can break a verdict.
