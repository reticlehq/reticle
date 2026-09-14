### Fixed

- **`@reticlehq/vite-plugin` — a disabled build shipped no _used_ SDK code, but still shipped the code.** `apply: 'serve'` only stopped the plugin from injecting `connect()`; the real `@reticlehq/browser` module was still resolved and bundled into `vite build` output, dead but present — readable in the shipped JS, inflating the bundle. The plugin now applies to `vite build` too and swaps the browser SDK for an inert stub at that point, so a production build contains zero real Reticle runtime code. Closes [#852](https://github.com/reticlehq/reticle/issues/852).
