### Fixed

- **`@reticlehq/server` — a replayed step whose anchor matches several elements is not proved, not failed, after earlier steps acted.** The control is on the page, and the replay cannot choose one, so the run decided nothing about the app. Before, this read as a failed flow once any earlier step had acted, so a correct build with a different layout failed. A control that is missing after earlier steps acted still fails.
