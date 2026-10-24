### Fixed

- **`@reticlehq/server` — the `reticle_tools` description taught a flow recipe that failed.** It went from `reticle_record { action: "start" }` straight to `reticle_flow_save`, which refuses a recording that is still running. The recipe now calls `reticle_record { action: "stop" }` first. The `reticle_tools` and `reticle_run` examples also named `reticle_network`, which the default surface answers only with a redirect. They now name tools that load directly.
