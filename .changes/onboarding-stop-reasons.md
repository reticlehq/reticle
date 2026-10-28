### Changed

- **`@reticlehq/server` — telemetry names why setup stopped.** A stop on the path to a first verdict, such as a Node that is too old, a dev server that did not start, or a missing Chromium, sent no reason or a free string. A failed `onboarding_step` row now carries `stop`, one name from a closed list in `@reticlehq/core`. No path, URL or app name is sent. `docs/telemetry.md` lists what leaves the machine.
