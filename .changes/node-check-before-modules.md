### Fixed

- **`@reticlehq/server` — a Node.js too old for Reticle got a module error, not the version line.** A Node.js that cannot load ES modules stopped before the version check ran. `reticle` now checks the Node.js version first, in code that every Node.js can read. It prints "Reticle needs Node.js 20.11 or later" and exits with code 1.
