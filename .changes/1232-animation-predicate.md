### Fixed

- **`@reticlehq/engine` + `@reticlehq/browser` — `animation` predicates now check live animations instead of only the event window.** An assertion could miss a CSS animation that was already running before the window opened, and `target: ".spinner"` was silently compared to Reticle refs. The predicate now reads the page's current animations as a fallback, reports animation names and targets on misses, and accepts either a Reticle ref or CSS selector for `target`. Closes [#1232](https://github.com/reticlehq/reticle/issues/1232).
