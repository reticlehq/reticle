### Fixed

- **`@reticlehq/init` — `reticle init` added a second `plugins` key to a Vite config.** When the config set `plugins` with a call (for example `plugins: wrap(() => [react()])`) or with the shorthand `{ plugins }`, init did not see an array and added its own `plugins: [reticle()]` key. The later key replaced the first, so one of the two plugin lists was lost, and init still said it wired the config. Init now leaves such a config unchanged and gives a manual step that says where to add `reticle()`.
