### Changed

- **`@reticlehq/server` — run ids are shorter.** A new run id is 16 hex characters. A drive's run id is `drive-` and a 16-character hash of the session id, not the full session id. Each step screenshot path that an agent reads contains the run id, so each action costs fewer tokens. Runs that an older version wrote keep their ids, and Reticle still reads them.
