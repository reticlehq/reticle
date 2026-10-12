### Fixed

- **`@reticlehq/server` — a Harness locked below the coverage gate said it was "off".** A freshly opened tab has recorded no gaps, so it passed the daemon's own per-tab check, and the next refusal in line was the platform's switch. The platform's project-wide lock now comes first, with the prompt that unlocks it.
