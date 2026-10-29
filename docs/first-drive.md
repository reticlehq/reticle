---
title: Your first drive
description: 'Clone to a real verdict in about fifteen minutes, and the traps that cost other people a debugging session.'
icon: play
noindex: true
---

The goal of this page is narrow and deliberate: **end with a real verdict on screen**, produced by Reticle against a running app, in a checkout you just cloned. Not a passing unit test, the thing the project exists to do.

Everything here is written from a run of these exact steps, including the places they bite.

## Before you start

```bash
node --version   # 22.15 or newer
pnpm --version   # this is a pnpm workspace; npm will not resolve it
```

```bash
git clone https://github.com/reticlehq/reticle && cd reticle
pnpm install
pnpm build       # required: the specs and the CLI run from dist/, not src/
```

`pnpm build` is not optional. Several things below load `server/dist`, and a stale or absent `dist` produces errors that read as code faults rather than as a missing build.

## 1. Boot something to look at

Three processes: the Reticle daemon, a demo API, and the bench app that talks to both.

```bash
node server/dist/command/cli.js serve --port 4400   # returns once the daemon answers
node apps/api/server.mjs &
RETICLE_PORT=4400 VITE_RETICLE_TOKEN="$(cat ~/.reticle/pairing-token)" \
  pnpm --filter @reticlehq/bench-app exec vite --port 4310 --strictPort &
```

Check both answered before going on, because a readiness check now saves a confusing failure later:

```bash
curl -s -o /dev/null -w "api=%{http_code} app=%{http_code}\n" \
  http://localhost:8787/api/saved-items http://localhost:4310/
```

The daemon writes `~/.reticle/pairing-token` when it starts, so start it before the bench app reads the token.

## 2. Take a verdict from the command line

This is the shortest path to seeing Reticle work, and it needs no MCP client at all. `--expect` asks the daemon you started in step 1 for the verdict; with no daemon on the port it refuses and proves nothing.

Ask for a verdict, naming the app's url. With no tab open on that origin, Reticle opens one in a browser it drives (Playwright's Chromium, or an installed Chrome or Edge when that is missing) and closes it afterwards; a tab you already have open is used instead:

```bash
node server/dist/command/cli.js verify http://localhost:4310/ --port 4400 \
  --expect '{"kind":"text","contains":"Reticle"}'
```

```
verified: yes
reason: proved
{ …the verdict as JSON… }
```

The command exits with code 0.

That is the whole product in one line: a claim, checked against a running page, with an exit code you can put in CI. `verified: "yes"` is the only pass, `unknown` means Reticle could not tell, and it exits non-zero on purpose.

Try making it fail, because a tool that only ever says yes is not telling you anything:

```bash
node server/dist/command/cli.js verify http://localhost:4310/ --port 4400 \
  --expect '{"kind":"text","contains":"definitely not on this page"}'
```

On Windows PowerShell, `npx.cmd` re-parses `--expect '{...}'` and strips the inner quotes. Prefer `--expect-file`:

```powershell
'{"kind":"text","contains":"Saved"}' | Set-Content expect.json
npx @reticlehq/server verify http://localhost:3000 --expect-file expect.json
```

## 3. Drive it properly, with the tools

If your editor has the Reticle MCP server, the same app is now drivable. The four calls worth knowing, in the order you actually use them:

- `reticle_look { action: "page" }`: what is on the page
- `reticle_look { action: "find", by: "testid", value: "..." }`: find one thing, cheaply
- `reticle_act_and_wait { ref, action, until }` (**the one that produces a verdict**)
- `reticle_observe`: everything the page did, when you need the evidence

`reticle_act` moves the app and proves nothing. A drive that ends without `act_and_wait` or `reticle_assert` has no result, however many calls it made.

## 4. Read a spec, then run one

The end-to-end specs are the best documentation of what Reticle guarantees, because each one is a property somebody was burned by. Short and readable:

```bash
node apps/e2e/specs/awkward-controls-test.mjs      # a file upload, an unnamed button, a canvas
node apps/e2e/specs/auth-retry-not-a-defect-test.mjs   # a 401 the app recovered from
```

The specs start their own bridge on port 14400 (`RETICLE_PORT`, default in `apps/e2e/gate-harness.mjs`), so the bench app must dial 14400, not the step-1 daemon on 4400. To run every spec, use `pnpm test:e2e`. It boots the API, the bench app and next-smoke on the correct ports, then runs the battery. To run one spec by hand, stop the bench app from step 1 and start it again with `RETICLE_PORT=14400`. Then run the spec. Your own daemon on 4400 can keep running.

## The things that will bite you

**The specs use port 14400, not 4400.** A daemon of your own on 4400 can keep running. If something holds 14400, a spec dies with `EADDRINUSE`. Do **not** `kill -9` whatever holds a Reticle port: on 4400 that can be the `reticle mcp` proxy, and killing it cuts your own agent's link with no log, because the process that writes the log is the one that dies. Use the harness, which spares the proxy:

```bash
node -e "import('./apps/e2e/gate-harness.mjs').then(m=>m.freePortSafely(14400,{onNote:console.log}))"
```

**The bench app self-assigns its session id.** Matching on a fixed name waits forever. Specs identify it by the URL it serves from. Copy that pattern.

**The bench app shows a login first, and views are reached from the nav.** A query parameter does not select a view. Log in, click the nav item, then drive.

**Fixtures are in a second repo.** The apps in `apps/` are all already instrumented, so none of them can tell you whether a fresh install still works. That question lives in `reticle-fixtures`, a private repository that the maintainers run. It keeps a pristine `clean` branch of real third-party apps plus `main` and `reticle/<version>`. See [Fixtures](/fixtures).

**Telemetry fails silently.** Nothing throws, no test reddens, the data is just permanently gone. Read [`contributing/telemetry/contract.md`](https://github.com/reticlehq/reticle/blob/main/contributing/telemetry/contract.md) before touching anything that emits.

**`core` is the contract and may not gain dependencies.** Anything crossing browser ↔ bridge ↔ agent is defined there as a constant plus a zod schema. Never inline a wire string elsewhere.

## Gate durations, measured

Run the fast gate before every commit. The others only when you touch what they cover.

| gate | when | measured |
| --- | --- | --- |
| `pnpm verify` (`format:check`, `lint`, `typecheck`, `test:unit`) | always | ~2 min |
| `pnpm test:e2e` | the tool surface, the wire contract, or an observer | ~8 min |
| `pnpm test:e2e:desktop` | Electron, Tauri, the IPC observer, desktop capture | ~3 min, needs a Rust toolchain |
| `pnpm gate:install` | `init`, `vite-plugin`, `next`, `babel-plugin` | ~15 min |

`pnpm verify` runs `format:check` first, because CI enforces formatting and `pnpm lint` does not check it. Without it, a branch that passes the other gates locally can still fail CI on formatting.

## Where to go next

- [`CONTRIBUTING.md`](https://github.com/reticlehq/reticle/blob/main/CONTRIBUTING.md): the rules, the layout, and the PR flow
- [Architecture](/architecture): how the pieces fit
- Issues labelled **good first issue**. Each names the file to start in, how to reproduce, and how you will know you are done. If one is still too vague, say so on the issue; that feedback is worth more than a guess.
