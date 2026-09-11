# `apps/` — what belongs here, and what does not

This directory grew without a rule, so things arrived for a reason and nothing recorded whether that reason was still being served. The result was three empty directories, two apps duplicating wiring the smoke apps already prove, and the hardest fixture in the repo run by nothing at all.

The rule is one sentence:

> **Every app here exists to answer a question a gate asks. If no gate asks it, the app does not belong here.**

Enforced by `packages/server/src/tools/integration-coverage.test.ts`, which fails when a shipped integration has no covering app and spec. It is a red build, not a convention.

## The three jobs — and nothing else

| Job | What it is | Size rule | Examples |
| --- | --- | --- | --- |
| **Integration proof** | One app per framework we publicly offer, proving the wiring works end to end | **Thin is CORRECT.** `electron-smoke` is 290 lines because its job is "the wiring works", not to be an app | `next-smoke`, `electron-smoke`, `tauri-smoke` |
| **Benchmark target** | A stable, measurable app for token/perf numbers | Whatever the measurement needs; keep it boring so numbers stay comparable | `bench-app`, `large-dom-bench` |
| **Adversarial fixture** | Built to be hard, to find what Reticle cannot see | Big, realistic, emergent defects. **One is enough** | `atlas` |
| **Support infrastructure** | Not apps under test: the backend the specs drive, and the runner itself | Whatever the battery needs | `api`, `e2e` |
| **Product demo** | Shows Reticle rather than testing it — carries its own benchmark and repair loop | Whatever the story needs | `vibe-builder-demo` |

**Every directory here states its job in the first line of its own README.** If you add one and it has no README, the next person cannot tell what it is for — which is exactly how this directory got confusing.

## Rules

1. **A new app needs a gate in the same change.** Not "later" — the spec is what makes it an asset rather than decoration.
2. **One app per framework we publicly offer.** The list of frameworks lives in `SKILL.md`, which is what users actually paste. If the skill offers it, there is an app and a spec for it.
3. **Thin integration apps are correct.** Do not grow them. A 290-line app that proves Electron wiring works is doing its whole job.
4. **Defects in the adversarial fixture are not planted to match our detectors.** See `atlas/README.md` — an app whose only bug is "this handler throws" will always be caught by "did a request fail", and catching it demonstrates nothing.
5. **A long-running app must not join the shared battery casually.** Every spec shares the bridge on `:4400`. Atlas streams SSE, and running it battery-wide floods every other spec's session — it turned five green specs red. Specs that need a noisy app spawn and kill it themselves, the way the desktop specs do.
6. **Vanilla (non-React) coverage is load-bearing.** `large-dom-bench` is plain TS on purpose. Folding it into a React app would delete the proof that the SDK works without React.

## Coverage today

Driven by what `SKILL.md` offers a user, which is the promise that must not break:

| Framework offered to users | App               | Gate           |
| -------------------------- | ----------------- | -------------- |
| Vite + React               | `bench-app`       | ✅ e2e         |
| Next.js                    | `next-smoke`      | ✅ e2e         |
| Remix                      | `examples/remix`  | ✅ integration |
| Astro                      | `examples/astro`  | ✅ integration |
| Plain HTML / vanilla       | `large-dom-bench` | ⚠️ bench only  |
| Electron                   | `electron-smoke`  | ✅ desktop     |
| Tauri                      | `tauri-smoke`     | ✅ desktop     |
| (Adversarial fixture)      | `atlas`           | ✅ e2e         |

Every framework the skill offers now has an app and a gate, and `integration-coverage.test.ts` fails if that stops being true in either direction — an option added to `SKILL.md` without an app goes red, and so does re-adding one we removed.

**Vue and Svelte/SvelteKit were REMOVED from the skill rather than left as unproven promises.** They were offered to users with no app and no gate; the SDK is framework-agnostic and may well work in both, but "may well work" is not support. `reticle init` still wires SvelteKit, and now says to the user's face that the wiring is untested.

`examples/astro` used to be the inverse — an app for a framework the skill never offered. Astro is now offered, because the app exists, the integration battery drives it, and it wires the SDK differently (Astro SSRs its own HTML, so the plugin's `index.html` injection never fires). Proof first, then the promise.
