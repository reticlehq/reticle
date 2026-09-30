### Fixed

- **`@reticlehq/init` — moving the bridge port appended a second pair of origins to an Electron renderer's CSP.** On a re-run with a new `--port`, the `connect-src` `init` had opened for the bridge gained `ws://localhost:<new> ws://127.0.0.1:<new>` beside the old pair instead of in place of it. The pair is now replaced; a loopback source the app wrote for itself is left alone.
