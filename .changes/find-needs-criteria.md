### Fixed

- **`@reticlehq/server` — `reticle_look { action: "find" }` with nothing to find answered `count: 0`.** A find naming no testid, text, role, label, placeholder, alt or `by`/`value` now refuses and names the fields to pass, instead of reporting that nothing on the page matches a question nobody asked. A container asked for itself (`self`) is unchanged.
