# Contributing to Reticle

Thanks for your interest in Reticle! Reticle is the **proof layer for AI agents** — it verifies a running web app from the inside, without screenshots. It instruments the DOM, network, routing, console, and framework state in your app, and exposes that to an agent over MCP as a `look → act → observe → assert` loop.

This guide covers how to set up the repo, the rules we hold the line on, and how to land a change. We aim to make contributing pleasant — if anything here is unclear, ask in [Discord](https://discord.gg/BwAbzv9ZRz) or open an issue.

**Looking for something to work on?** [`good first issue`](https://github.com/reticlehq/reticle/labels/good%20first%20issue) is scoped, reviewed, and has a pointer to the file to start in. [`help wanted`](https://github.com/reticlehq/reticle/labels/help%20wanted) is bigger and unclaimed. Comment on the issue to claim it — we'll answer within a day, and nobody else will start on it once you have. For a first contribution with no code, [`good-first-skill`](https://github.com/reticlehq/reticle/labels/good-first-skill) issues ask for one `SKILL.md` that teaches an agent a verification recipe.

By participating you agree to our [Code of Conduct](CODE_OF_CONDUCT.md).

---

## Prerequisites

- **Node.js `>=22.12`** (see `engines` in the root `package.json`).
- **pnpm `10.x`** — the repo pins `pnpm@10.33.2` via `packageManager`. The easiest way to get the right version is [Corepack](https://nodejs.org/api/corepack.html):

  ```bash
  corepack enable
  ```

This is a single git repo — a **pnpm + [turbo](https://turbo.build/) monorepo**. Install everything from the root, and install the pre-commit hook while you are there:

```bash
pnpm install
pnpm hooks:install    # symlinks pre-commit.sh — runs format → lint → types → tests on staged files
```

The hook is optional and mirrors the fast gate, so it catches locally what CI would catch in ten minutes. It is not installed automatically; a repo that silently writes to your `.git/hooks` on `install` is a repo you cannot trust with a `postinstall`.

### Fifteen minutes to a real verdict

Before anything else, see the thing working: **[`docs/first-drive.md`](docs/first-drive.md)** takes you from `git clone` to a verdict on screen against a running app. A first ten minutes that ends with a passing unit test tells you the repo builds; it does not tell you what this project does.

### What will bite you

Every item here cost somebody a debugging session. None is discoverable by reading the code.

- **Port 4400 is the bridge, and something is probably on it.** Every e2e spec binds it, so a spec run with your editor's MCP client open dies with `EADDRINUSE`. Never `kill -9` the holder: on 4400 that list includes the `reticle mcp` proxy, and killing it cuts your own agent's link **with no log**, because the process that writes the log is the one that dies. Use `freePortSafely` from [`apps/e2e/gate-harness.mjs`](apps/e2e/gate-harness.mjs), which spares the proxy by design.
- **Telemetry fails silently.** Nothing throws, no test reddens, the data is just permanently gone — `daemon_stopped` was fired just before `process.exit(0)` for months and every POST died unseen. Read [`docs/telemetry-contract.md`](docs/telemetry-contract.md) first.
- **The fixtures are in a second repo.** Every app in `apps/` is already instrumented, so none of them can tell you whether a fresh install still works — re-running `init` over one reports "already wired" for every step and proves nothing. That question lives in [`reticle-fixtures`](https://github.com/reticlehq/reticle-fixtures), which keeps a pristine `clean` branch of real third-party apps plus `main` and `reticle/<version>`. See [`docs/fixtures.md`](docs/fixtures.md).
- **`core` is the contract and does not get new dependencies.** It depends only on `zod` and `open-verification`. Anything that crosses browser, bridge and agent is a named constant plus a zod schema in `core`. A wire string written inline in `browser` or `server` is a bug.
- **A new tool field needs several allowlists.** Miss one and the call silently returns nothing — measured, twice. If you add a field and it "does not arrive", start by grepping for every place the existing fields are listed.
- **`format:check` is not run by `pnpm lint`.** CI enforces it separately, so all four heavy gates can be green locally and CI still red on formatting alone.
- **A local gate is only trustworthy in a quiet checkout.** If something else is editing the same worktree, turbo will read files mid-write and report failures that are not yours.

### Your first change: pick the smallest useful one

- **Three minutes, highest value:** submit an MCP-client compatibility record. Most rows in [`docs/matrix/MATRIX.md`](docs/matrix/MATRIX.md) are `◐` — meaning `init` writes a runnable entry and _nobody has ever run that client_. See [`docs/matrix/README.md`](docs/matrix/README.md).
- **An afternoon:** [`good first issue`](https://github.com/reticlehq/reticle/labels/good%20first%20issue) — scoped, reviewed, with a pointer to the file to start in.
- **Found a bug in Reticle while using it?** `reticle feedback --agent --kind bug "what happened"` files it from the shell, no GitHub account needed.

---

## The rules

The layout, the package boundaries, the coding rules, the names and the gate to run for each change are in **[`AGENTS.md`](AGENTS.md)**. Your coding agent reads the same file, so you and your agent follow one set of rules. Read it before your first change.

Every change runs `pnpm verify`. Some changes need one more gate: the table in `AGENTS.md` names it, and [`docs/gates.md`](docs/gates.md) explains each gate. CI also routes by path, and `gate` counts a skipped job as green. When you are not sure, run the gate.

`pnpm bench` is the benchmark harness. It is research, not a gate (see [`bench/README.md`](bench/README.md)).

## What must be green to merge

`gate` plus `dco`. Bench and the full Windows install matrix still run only after merge, quarantined in [`.github/flaky.json`](.github/flaky.json); each one joins the merge queue, and leaves that file, after three consecutive green nightlies on `main`.

---

## Running the demo app locally

`apps/bench-app` is the React dashboard we use to dogfood Reticle (tabs, lists, modals, forms, API calls).

```bash
pnpm install                 # once, from the repo root
pnpm --filter @reticlehq/bench-app dev   # http://localhost:4312
```

From there, point your MCP-capable agent at Reticle and ask it to verify the app — see [`docs/getting-started.md`](docs/getting-started.md) for the full walkthrough.

---

## Commit and pull-request flow

The rules are in [`AGENTS.md`](AGENTS.md#commits-and-pull-requests). This section tells you how to fix the two problems that most often stop a PR.

**A commit has no sign-off.** CI's [Developer Certificate of Origin](https://developercertificate.org) check needs a `Signed-off-by:` line on every commit. Use `git commit -s`. To fix commits that you already made:

```bash
git commit --amend --no-edit -s          # one commit
git rebase --signoff origin/main         # several commits
git push --force-with-lease
```

`git config format.signOff true` does not apply to `git commit`. To add the line automatically, run `pnpm hooks:install`. It installs a `prepare-commit-msg` hook that adds the line, and the pre-commit gate.

**The PR is blocked, every check is green, and no reason is given.** Your branch has a merge commit. The merge queue replays your branch on top of `main`, and it cannot replay a merge commit. Rebase instead of merging: `git rebase --signoff origin/main`, then push with `--force-with-lease`.

For a large change, open an issue first, so that we can agree on the approach before you write the code.

### What you can expect from us

- **A reply to a claim or a question within a day, and a first review within two days.** If a PR has waited longer, say so on it; that is on us, not you.
- **CI on a pull request takes about ten minutes.** The slowest suites (the benchmark and the full Windows install matrix) run after merge and nightly instead, so a PR you can act on is not held up by a job you cannot. Each one is quarantined in `.github/flaky.json` until it is green enough to join the merge queue. Windows unit tests run on a PR when Windows-sensitive source changed.
- **Once it is approved, the merge queue lands it.** You do not need to keep rebasing while it waits.

### AI-assisted contributions

Welcome, on one condition: **the tests must fail without your change.** Revert your fix locally and run the test you added; if it still passes, it is not testing the fix, and a green test that proves nothing is the one defect this project exists to catch. Say in the PR description that you checked. PRs that only reformat, rename or reword without an issue behind them will be closed.

---

## License of contributions

Reticle uses a per-package license model (Apache-2.0 for the embeddable SDK packages, FSL-1.1-ALv2 for the server / CLI / umbrella, and the Reticle Enterprise License for `server/src/features/ee/`). By contributing, you agree that your contribution is licensed under the license of the package(s) you're modifying. See the root [LICENSE](LICENSE) and each package's own `LICENSE` file.
