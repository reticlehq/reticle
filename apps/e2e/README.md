# e2e — the test runner, not an app

For a quick product check, run **`pnpm test:smoke`** from the repository root. It builds the required
packages and drives an isolated real browser through stdio MCP, including positive and negative
verdicts. Install Chromium once with `pnpm exec playwright install chromium`. Evidence is saved in
`artifacts/smoke/`; no external app, registry, or model is needed. See [the gate guide](../../docs/gates.md)
for coverage limits and the full install/E2E commands.


**Job: support infrastructure.** This is the battery itself. It lives under `apps/` for historical
reasons; nothing here is an application under test.

- `run-ci.sh` starts the servers the web specs need (api, bench-app, next-smoke) and then runs the battery.
- `run-desktop.sh` runs the desktop battery, which starts its own runtimes.
- `run.mjs` sequences the specs. **A spec on disk but in no list is silently un-run rot** — that is
  what the ORDER/DESKTOP/SKIP lists exist to prevent.
- `specs/` is one file per spec. `desktop-harness.mjs` boots a bridge + a desktop runtime.

**Adding a spec?** Put it in a list in `run.mjs`, or it will never run and nobody will notice.

The web and desktop batteries use bridge port `14400` and private daemon state by default, so an
existing daemon on `4400` can keep serving its clients. Override with `RETICLE_PORT=14401`.
Atlas uses `14320` (`ATLAS_TEST_PORT` overrides it). Occupied fixture ports cause a refusal;
cleanup stops only processes started by the run.
