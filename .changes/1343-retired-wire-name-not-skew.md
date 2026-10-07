### Fixed

- **`@reticlehq/core` + `@reticlehq/server`: a page on SDK 3.1–3.4 is not version-skewed by a name the daemon retired.** Since 3.5.0 every verdict on such a page was `unknown` (`version_skew`), because the page still sends `webmcp`, an action the daemon removed. Retired wire names are now kept in core and ignored, and the skew sentence says which side is older instead of always calling the page newer. Closes [#1343](https://github.com/reticlehq/reticle/issues/1343).
