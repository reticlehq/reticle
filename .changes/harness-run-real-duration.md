### Fixed

- **`@reticlehq/server` — a Harness run could reach the dashboard as "Took 0 ms".** Its duration was the span of the actions one tab's journal held for it, and a lane that drove in its own browser left only the grade's one check in the tab. The Harness now times its own drive on the daemon's clock and the run carries that.
