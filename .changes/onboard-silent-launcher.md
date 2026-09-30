### Fixed

- **`@reticlehq/server`: `init` proves the connect even when your browser silently fails to open.** A launcher can report success and show nothing — macOS `open` against a default browser that is not answering exits only after the launch check has counted it as opened — and `init` then waited out its whole connect budget over a correct install. If no tab connects within 15 seconds of opening the system browser, `init` now opens the app in a Reticle-owned headless browser and proves the connect there.
- **`@reticlehq/init`: Nuxt is only told to restart when something changed.** A re-run that found the plugin and config in place, attached to the running server and connected, still printed "Restart the Nuxt dev server".
