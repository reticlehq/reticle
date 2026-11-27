### Fixed

- **`@reticlehq/server` — setup no longer opens Vite's separate HMR port.** An Express app can host Vite in middleware mode on one port while the HMR WebSocket listens on another. The WebSocket port answers an ordinary GET with `426 Upgrade Required`, and setup could open that answer instead of the app. Setup now probes the candidate ports and chooses one that serves HTML. The no-session scan also stops counting a `426` listener as a page. Closes [#2288](https://github.com/reticlehq/reticle/issues/2288).
