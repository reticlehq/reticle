### Fixed

- **`@reticlehq/browser` — the destructive-action guard read hidden text inside a button.** A chat button named "Ask the agent" was refused as destructive because it holds a hidden "Drop files here" hint, so an agent had to pass `confirmDangerous: true`. The guard now reads the text that a person can see, and the accessible name. Closes [#2478](https://github.com/reticlehq/reticle/issues/2478).
