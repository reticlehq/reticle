### Fixed

- **`@reticlehq/core` — the coverage prompt linked a skill page that did not exist.** The prompt that `init` and `reticle doctor` print for the coding agent started with "Read https://reticle.sh/SKILL.md". That address answered 404, so the agent started without the skill. The prompt now links `https://docs.reticle.sh/skill.md`.
