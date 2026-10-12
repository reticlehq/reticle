### Fixed

- **`@reticlehq/vite-plugin` — in a production build, `commitAndSignal` dropped the app's own state change.** The plugin swaps the SDK for an inert stub in `vite build`, and the stub's `commitAndSignal` was an empty function: the `mutate` callback it wraps never ran and the call returned `undefined`. Reticle still does nothing in production; the app's write now runs and its value comes back.
