### Fixed

- **`@reticlehq/server` — `reticle connect` printed ~90 near-identical "N run(s) in ~/.reticle/unmatched/… are not on your dashboard" lines before "Connected".** Unclaimed buckets fold into one line, other folders are named up to five, and `reticle doctor` lists every one.
- **`@reticlehq/server` — `reticle_session { action: "list" }` with nothing connected returned ~3 KB of ranked, speculative causes.** It carries the lead and its next action, as the CLI already did.
- **`@reticlehq/browser` — a tab the daemon once refused (a restart under another pairing, say) never tried again, and needed a reload.** It still makes no timed retries after a refusal, but tries once more when the person comes back to the tab.
