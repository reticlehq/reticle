### Fixed

- **`@reticlehq/server` — `reticle init` gave every project the same port when the default was taken.** Each project moved off a busy default asked for the default plus one, so with the first one's daemon not running yet the second and third were all written `4401` and shared it. A project now asks for a port of its own, derived from its id, the same on every run, and still skips a taken one.
- **`@reticlehq/server` — an agent moved off another project's port started a visible browser nobody asked for.** When `reticle mcp` found the requested port serving a different project it relocated to a random port and started a headed daemon there. A daemon on a port nobody chose now starts headless.
