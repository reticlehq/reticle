### Changed

- **`@reticlehq/server` — `reticle verify` called every run with `CI` set an OEM pipeline.** A coding-agent sandbox sets `CI` too, so a remote agent session showed as a pipeline, with trigger `oem`. The command line now reads the `automation` hint. A CI vendor runner (for example, `GITHUB_ACTIONS`) sends trigger `ci`. A coding-agent sandbox (`CLAUDE_CODE_REMOTE`) sends agent kind `coding-agent` and trigger `manual`. A container, or `CI` with no vendor variable, still sends trigger `oem`.
