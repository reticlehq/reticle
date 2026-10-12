### Added

- **An intent's proof names the run it landed in.** When a check proves an intent, `provenBy` now carries `runId` beside the verdict, grade and time, so the platform links the proof to its run by id instead of by a time window. The field is optional; older records read as before.
