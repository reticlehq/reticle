---
title: Fixture apps
description: 'Why the apps in apps/ cannot answer the one question that matters before a release, and what does.'
icon: cubes
---

The apps in `apps/` cannot tell you whether the install still works, because every one of them is already wired to Reticle. That question is answered in a separate repo, **[`reticle-fixtures`](https://github.com/reticlehq/reticle-fixtures)**, which keeps a pristine `clean` branch of real third-party apps and runs `node scripts/verify.mjs` to install into each one and assert a session actually connects.

The apps in `apps/` are ours. We chose their defects, so passing against them says less than it looks like, and they are all wired to Reticle already, which makes them useless for the one question that matters before a release: **does the install still work on an app that has never seen Reticle?**

That question is answered in a separate repo: **[`reticle-fixtures`](https://github.com/reticlehq/reticle-fixtures)**.

## Why it is a separate repo

Three reasons, each of which bit us before the split:

- **They are somebody else's package managers.** `react-admin` is a yarn monorepo. Putting it under `apps/*` makes it a member of this pnpm workspace and breaks `pnpm install` for everyone.
- **They need a branch model this repo cannot give them.** A fresh install is only meaningful on a surface that has never been instrumented. Re-running `init` over an already-wired app reports `·` (already wired) for every step and proves nothing, which is exactly how an install regression ships unnoticed. `reticle-fixtures` keeps a pristine `clean` branch for that, plus `main` at the latest version and `reticle/<version>` per release.
- **They are large.** The upstream checkouts were eight gigabytes of somebody else's git history sitting gitignored inside this repo.

## What runs there

```bash
node scripts/materialise.mjs   # build apps/ from fixtures.json at pinned refs
node scripts/verify.mjs        # install into every clean app, boot it, assert a session connects
```

The last step is the one that earns its keep. Every install bug found so far has been silent: the app boots, the `init` report reads clean, and nothing connects. Next.js shipped in that state through a whole release: three independent defects, none visible to any check short of opening a browser and looking at `reticle status`.

## What stays here

`apps/` holds bench-app, next-smoke, the Remix and Astro examples, the Electron and Tauri smoke apps, atlas, and the API. These are the CI gates (`pnpm test:e2e`, `pnpm test:e2e:desktop`), and `integration-coverage.test.ts` fails if one of them goes missing while `SKILL.md` still offers its framework.

The split is: **`apps/` proves the tools work. `reticle-fixtures` proves the install works.**

## Wiring Tier 2 (not yet live)

CI can ask this repo to verify a Reticle commit automatically, in the [`vite-ecosystem-ci`](https://github.com/vitejs/vite-ecosystem-ci) shape, where a separate repo holds the downstream apps and the main repo asks it to run. The sending half is built (`fixtures-dispatch` in `.github/workflows/ci.yml`); the receiving half is a template at [`docs/fixtures-dispatch-receiver.yml`](./fixtures-dispatch-receiver.yml).

**It is inert until two things happen, and neither can be done from inside this repository:**

1. A fine-grained PAT with **Actions: write** on `reticlehq/reticle-fixtures`, added to `reticlehq/reticle` as the secret `FIXTURES_DISPATCH_TOKEN`. Until it exists the job logs that Tier 2 is unwired and exits 0. It never reddens CI, because a dispatch failure has nothing to do with the change being pushed.
2. The template copied into `reticle-fixtures` as `.github/workflows/verify-on-dispatch.yml`.

The template lives in the _sending_ repo deliberately: the two halves must agree on an event name and payload shape, and a contract whose ends live in different repositories drifts the first time somebody edits one of them.

**Nothing here has ever run.** Treat every line as unverified until somebody has watched one green run. Tier 2 being present in the plan is not Tier 2 being live.

### Why Tier 2 exists when Tier 1 already passes

`pnpm gate:install` (Tier 1) scaffolds pristine apps and catches install **regressions**. It cannot catch install **complexity**: `rowy` is 70 dependencies of somebody else's product, `phanpy` has a 130-line vite config holding ten plugins inside a `defineConfig` callback. That is where install bugs actually hide, and a scaffold deliberately has none of it. The two tiers answer different questions and neither substitutes for the other.
