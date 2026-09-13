---
title: Your first drive
description: 'Clone to a real verdict in about fifteen minutes, and the traps that cost other people a debugging session.'
icon: play
---

The goal of this page is narrow and deliberate: **end with a real verdict on screen**, produced by Reticle against a running app, in a checkout you just cloned. Not a passing unit test, the thing the project exists to do.

Everything here is written from a run of these exact steps, including the places they bite.

## Before you start

```bash
node --version   # 22 or newer
pnpm --version   # this is a pnpm workspace; npm will not resolve it
```

```bash
git clone https://github.com/reticlehq/reticle && cd reticle
pnpm install
pnpm build       # required: the specs and the CLI run from dist/, not src/
```

`pnpm build` is not optional. Several things below load `packages/server/dist`, and a stale or absent `dist` produces errors that read as code faults rather than as a missing build.

## 1. Boot something to look at

Two processes: a demo API and the bench app that talks to it.

```bash
node apps/api/server.mjs &
RETICLE_PORT=4400 VITE_RETICLE_TOKEN="$(cat ~/.reticle/pairing-token)" \
  pnpm --filter @reticlehq/bench-app exec vite --port 4310 --strictPort &
```

Check both answered before going on, because a readiness check now saves a confusing failure later:

```bash
curl -s -o /dev/null -w "api=%{http_code} app=%{http_code}\n" \
  http://localhost:8787/api/saved-items http://localhost:4310/
```

If `~/.reticle/pairing-token` does not exist yet, run any `reticle` command once and it will be minted.

## 2. Take a verdict from the command line

This is the shortest path to seeing Reticle work, and it needs no MCP client at all.

Open the app in a browser. Use a real one, or:

```bash
node -e "require('playwright').chromium.launch({headless:true})
  .then(b=>b.newPage().then(p=>p.goto('http://localhost:4310/')
  .then(()=>new Promise(r=>setTimeout(r,60000)))))" &
```

Then ask for a verdict:

```bash
node packages/server/dist/cli.js verify "" --port 4400 \
  --expect '{"kind":"text","contains":"Reticle"}'
```

```
verified: yes
reason: proved
exit=0
```

That is the whole product in one line: a claim, checked against a running page, with an exit code you can put in CI. `verified: "yes"` is the only pass, `unknown` means Reticle could not tell, and it exits non-zero on purpose.

Try making it fail, because a tool that only ever says yes is not telling you anything:

```bash
node packages/server/dist/cli.js verify "" --port 4400 \
  --expect '{"kind":"text","contains":"definitely not on this page"}'
```

## 3. Drive it properly, with the tools

If your editor has the Reticle MCP server, the same app is now drivable. The four calls worth knowing, in the order you actually use them:

- `reticle_snapshot`: what is on the page
- `reticle_query { by: "testid", value: "..." }`: find one thing, cheaply
- `reticle_act_and_wait { ref, action, until }` (**the one that produces a verdict**)
- `reticle_observe`: everything the page did, when you need the evidence

`reticle_act` moves the app and proves nothing. A drive that ends without `act_and_wait` or `reticle_assert` has no result, however many calls it made.

## 4. Read a spec, then run one

The end-to-end specs are the best documentation of what Reticle guarantees, because each one is a property somebody was burned by. Short and readable:

```bash
node apps/e2e/specs/awkward-controls-test.mjs      # a file upload, an unnamed button, a canvas
node apps/e2e/specs/auth-retry-not-a-defect-test.mjs   # a 401 the app recovered from
```

Both need step 1's processes running, and both need port 4400 free. See the traps below.

## The things that will bite you

**Port 4400 is the bridge, and something is probably on it.** Every spec binds it. If your editor has an MCP client open, its daemon owns that port and a spec dies with `EADDRINUSE`. Do **not** `kill -9` the holder: on 4400 that list includes the `reticle mcp` proxy, and killing it cuts your own agent's link with no log, because the process that writes the log is the one that dies. Use the harness, which spares the proxy:

```bash
node -e "import('./apps/e2e/gate-harness.mjs').then(m=>m.freePortSafely(4400,{onNote:console.log}))"
```

**The bench app self-assigns its session id.** Matching on a fixed name waits forever. Specs identify it by the URL it serves from. Copy that pattern.

**The bench app shows a login first, and views are reached from the nav.** A query parameter does not select a view. Log in, click the nav item, then drive.

**Fixtures are in a second repo.** The apps in `apps/` are all already instrumented, so none of them can tell you whether a fresh install still works. That question lives in [`reticle-fixtures`](https://github.com/reticlehq/reticle-fixtures), which keeps a pristine `clean` branch of real third-party apps plus `main` and `reticle/<version>`. See [`fixtures.md`](fixtures.md).

**Telemetry fails silently.** Nothing throws, no test reddens, the data is just permanently gone. Read [`telemetry-contract.md`](telemetry-contract.md) before touching anything that emits.

**`core` is the contract and may not gain dependencies.** Anything crossing browser ↔ bridge ↔ agent is defined there as a constant plus a zod schema. Never inline a wire string elsewhere.

## Gate durations, measured

Run the fast gate before every commit. The others only when you touch what they cover.

| gate | when | measured |
| --- | --- | --- |
| `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test:unit` | always | ~2 min |
| `pnpm test:e2e` | the tool surface, the wire contract, or an observer | ~8 min |
| `pnpm test:e2e:desktop` | Electron, Tauri, the IPC observer, desktop capture | ~3 min, needs a Rust toolchain |
| `pnpm gate:install` | `init`, `vite-plugin`, `next`, `babel-plugin` | ~15 min |

`format:check` is first because CI enforces it and `pnpm lint` does not run it, a branch with all four heavy gates green locally can still turn CI red on formatting alone.

## Where to go next

- [`CONTRIBUTING.md`](../CONTRIBUTING.md): the rules, the layout, and the PR flow
- [`architecture.md`](architecture.md): how the pieces fit
- Issues labelled **good first issue**. Each names the file to start in, how to reproduce, and how you will know you are done. If one is still too vague, say so on the issue; that feedback is worth more than a guess.
