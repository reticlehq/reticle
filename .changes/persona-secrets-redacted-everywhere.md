### Fixed

- **`@reticlehq/server` — a password typed into a Harness persona reached the synced run.** The persona is now redacted where every drive starts (the agent's explore, the HUD, the dashboard's chat and `reticle verify`), so the text the platform receives, the flows' intent and the synced run's journey name all carry `[redacted]` in its place.
