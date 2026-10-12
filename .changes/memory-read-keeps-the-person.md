### Fixed

- **`@reticlehq/server` — `reticle_memory` could hide the one fact a person wrote.** A read capped at ten returned six copies of one persona's intent (one per page it had driven) and cut the statement a teammate had written, while a statement set aside seconds earlier still ranked second. A read now shows each statement once, drops what was set aside, and ranks proved, then agreed, then what a person wrote, then flow intents; `total` counts the distinct statements still standing.
