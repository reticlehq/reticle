### Fixed

- **`@reticlehq/server` — `reticle stop --force` refused a port held by another program and told you to run it again with `--force`.** You just had. The refusal now names the override that works, `reticle restart --force`, and says `stop --force` never takes it.
- **`@reticlehq/server` — `reticle --help` said `open` shows the app "in the browser Reticle drives".** It opens your own default browser, or reuses a tab that is already connected, and now says so.
- **`@reticlehq/server` — `reticle_visual_diff` told agents its `threshold` defaults to 0.01.** The diff uses 0.1. The description now reads the same constant the diff does.
