# e2e — the test runner, not an app

**Job: support infrastructure.** This is the battery itself. It lives under `apps/` for historical
reasons; nothing here is an application under test.

- `run-ci.sh` starts the servers the web specs need (api, bench-app, next-smoke) and then runs the battery.
- `run-desktop.sh` runs the desktop battery, which starts its own runtimes.
- `run.mjs` sequences the specs. **A spec on disk but in no list is silently un-run rot** — that is
  what the ORDER/DESKTOP/SKIP lists exist to prevent.
- `specs/` is one file per spec. `desktop-harness.mjs` boots a bridge + a desktop runtime.

**Adding a spec?** Put it in a list in `run.mjs`, or it will never run and nobody will notice.
