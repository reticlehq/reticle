### Fixed

- **`@reticlehq/browser`, `@reticlehq/server`, `@reticlehq/core` — the HUD's Harness page lost its log, never linked the result, and went silent when a run could not go on.** The page's state now comes from the daemon's snapshot rather than its own view:
  - The step log survives closing and reopening the Harness page (or the HUD) mid-run: the daemon keeps the drive's latest lines (`harnessDrive.lines`) and the page paints them whenever its log is empty.
  - At the end, "See the result ↗" beside Run links the run on the dashboard (`lastDrive.runUrl`).
  - A person reloading the page mid-run stops the drive, and the page says "The page reloaded, so this run stopped. Run again." A reload Reticle itself asked for (a replay, a durable recheck, `reticle_navigate { reload }`) is not mistaken for one.
  - When Run cannot start (the cloud unreachable, a refusal, an error), the reason stays on the Run row (`lastDrive.said`), not only in the log. Unreachable reads "Reticle Cloud at <url> did not answer, so the Harness cannot start. Check your connection, then Run again."
