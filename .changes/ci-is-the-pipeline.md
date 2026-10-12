### Fixed

- **`@reticlehq/server` — a CI run of `reticle verify` against a running daemon was recorded as an ordinary coding agent, triggered by hand, and credited to whoever minted the key.** The saved flows replay through the daemon as the client `reticle-cli`, and that path credited the caller as an agent. The command line is the pipeline on every path now, as it already was when `verify` boots its own daemon.
- **`@reticlehq/server` — `reticle verify` exited 0 while the platform refused the project's key, under a block that said "Saved: the daemon syncs this run".** The block now says the run is not on the platform and why, and a suite whose run the platform refuses exits non-zero.
- **`@reticlehq/server` — `reticle gate` printed `"pass": true` while exiting 1 or 3, and its refused-key sentence ended in "..".** The JSON line is written once the exit code is decided, and says what it says.
- **`@reticlehq/server` — version skew between two builds of the same version told the user to install that version, which both sides already had.** It now says to run `reticle restart` and reload the page.
