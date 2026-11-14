### Fixed

- **`@reticlehq/browser`, `@reticlehq/engine` — an element that CSS fades to almost no opacity read as `visible`.** An app that crossfades an element out left it at a very small opacity, and no check could prove that it went away. Now `state: "visible"` reads an element as not visible when its composed opacity (its own opacity times the opacity of its ancestors) is below 0.05. The tool text for faded text now says to assert it `absent` in `state: "visible"`. Closes [#2331](https://github.com/reticlehq/reticle/issues/2331)
