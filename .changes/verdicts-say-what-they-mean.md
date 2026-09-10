### Fixed

- **A verification run that checked nothing no longer reports a pass.** `reticle verify` on a project with no saved flows replayed nothing and answered PASS: the command exited 0, the report printed a tick, and the run counted as verified. The caveat was being emitted, into a `confidence` field that nothing reads. Verdicts now have a fourth answer, `unknown` — nothing passed and nothing failed, so nothing was proved — and it covers both an empty run and one whose every flow was skipped. The exit code is 1, so a build cannot go green on a run that checked nothing.

- **A verdict now names the pending call you were told to re-check.** When a write answers `202 Accepted` the server has not finished with it, so the window cannot contain the outcome and the verdict says to come back once it reconciles. It did not say _which_ call, so in a window with several requests you had to guess. It now names them, as `METHOD url`.

- **Reticle refuses to overwrite a project file it does not understand.** Recording a run repaired a damaged `.reticle/project.json` by starting fresh, which is right for a file that was truncated mid-write. A file written by a _different version_ of Reticle is not damaged, and repairing it threw away run history that the version which wrote it could still read. Reticle now stops and says so, and leaves the file alone.

### Added

- **`reticle_capabilities` now reports what a session cannot observe.** It listed what the app offers — testids, signals, stores, flows — and said nothing about instrumentation that is switched off. So a verification could be planned around a request body and only then be refused for a session that records none. A live read now carries `cannot`, naming each absence, what it costs, and what to do about it. Absences that are usually deliberate say so, rather than telling you to fix a setting that is correct.

- **A change log for the wire contract, at `core/CHANGES.md`.** If you maintain something that talks to Reticle, this is where to look: one line per change, newest first, written to be read from outside this repository. A check keeps it honest — the contract cannot change without an entry being added.
