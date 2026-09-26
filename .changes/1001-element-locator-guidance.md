### Fixed

- **`@reticlehq/engine` — element predicate errors now map query-tool role locators to the supported predicate shapes.** A locator copied from `reticle_query` was rejected without showing where its role belongs, forcing trial-and-error retries. The error now prints both accepted equivalents. Addresses item 4 of [#1001](https://github.com/reticlehq/reticle/issues/1001).
