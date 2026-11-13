### Added

- **`@reticlehq/server` — `reticle grade` grades a finished run of an app from snapshots of its stored data.** `grade snapshot` reads the declared state sources and the page the run ended on. `grade judge` compares a run with two runs of the correct steps, ignores what changes between those two, and checks the final answer against a source read at grade time. A source with no rows means the task cannot be done. `grade tables` and `grade suggest` write the state declaration from a database's table list, and drop the tables that change on every run. It needs no daemon and no browser.

### Changed

- **`@reticlehq/server` — a state `ignore` pattern that matches all of a text row removes the row.** Before, it left an empty row, so a row that only one build had still made the readings differ.
