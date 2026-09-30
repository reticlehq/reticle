### Fixed

- **`@reticlehq/server` — a `pressed` check against a page on an older SDK passed without being checked.** The `pressed` element state is new in this release, and a page built on 3.3 or earlier cannot see it, so it reported every toggle as not pressed and a `{ state: "pressed", absent: true }` check passed whatever the page showed. When the page's SDK predates a state, the check is now inconclusive and names the version to update to.
