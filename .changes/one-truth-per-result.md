### Fixed

- **`@reticlehq/server` — `reticle_verify { action: "flows" }` said `status: "unverifiable"` while its own result block said "proved · 1 of 1 check held".** A green replay a channel contradicted (a duplicate request, say) was counted as held in the block. The block now decides each flow as the synced run does, so a contradicted green is undecided there too.
- **`@reticlehq/server` — a deliberate Harness refusal ("Your 10 free credits are used…", "cannot drive the Harness right now", "Could not confirm Harness access") was labelled "not one Reticle recognizes, which means it may be a defect in Reticle".** They are recognised refusals now, with the way out instead of a request for a bug report.
- **`@reticlehq/server` — an agent session's result block gave its wall time from the last page load ("1.2s" for a ten-second session that navigated).** The tab's clock restarts at every load; the stretches between loads now add up.
- **`@reticlehq/server` — `reticle status` printed the agent link as a raw state name (`enumerated`, `never-enumerated`).** It says what it means, and the fix when there is one; `--json` keeps `mcpClient` and adds the sentence as `mcpClientSaid`.
