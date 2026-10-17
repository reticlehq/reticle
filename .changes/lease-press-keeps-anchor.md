### Fixed

- **`@reticlehq/server` — a key pressed on a named element of a lease was saved with no anchor.** The real keyboard reports no element, so the step was saved as a placeholder that no replay can find. The press now carries the test id, role and name that focusing the element reported, and the step replays.
