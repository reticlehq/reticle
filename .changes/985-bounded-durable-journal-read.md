### Fixed

- **`@reticlehq/server` — bound durable event-journal reads and retained evidence.** A long-lived session could make journal-backed queries materialize an oversized event file as one string and retain every parsed event indefinitely. Reads now keep the newest complete records under a 32 MiB read ceiling, with separate retention budgets of 32 MiB of serialized event data and 100,000 records. Evicted payload references are released immediately, rather than remaining reachable until cache-slot compaction. Short reads decode only bytes actually returned, and capped reads align to record boundaries before decoding UTF-8.

  Lost evidence is reported through `readLoss()` and the session's verdict-facing `lostSince()` check. Parsed cache evictions have an inclusive timestamp boundary. Skipped file bytes do not: their timestamps remain unknown, because a page reload can reset its clock while retaining the journal's session id. The surviving tail is not treated as proof that discarded history was complete.

  This change bounds event reads and retained evidence, not journal writes or repeated state-event production. The action-ledger reader and filesystem adapters without bounded-read support retain their existing whole-file behavior. Refs [#985](https://github.com/reticlehq/reticle/issues/985).
