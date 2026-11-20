### Fixed

- **`@reticlehq/server` — on Linux, a lease said Chromium was not installed when a system library was missing.** Chromium was installed, but the host had no `libnspr4`, `libnss3` or `libdbus-1`. The browser started, the loader refused it with "cannot open shared object file", and Reticle told the agent to run `npx playwright install chromium`, which does nothing for a missing library. That error now gets the same hint as Playwright's own host check: run the `install-deps` command.
