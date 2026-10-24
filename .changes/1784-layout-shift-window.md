### Fixed

- **`summary.layoutShift` counted the page since load, including Reticle's own HUD.** Each `act_and_wait` reported the running total, so an action that shifted nothing still showed a larger number, and a shift whose only source was the HUD was included. The summary is now the shift inside that action's window, and a shift that only moves Reticle's UI is left out. See [#1784](https://github.com/reticlehq/reticle/issues/1784).
