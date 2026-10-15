### Fixed

- **`@reticlehq/engine` — every text check failed against a page on an SDK older than 3.7.0.** Engine 3.7.0 sent `matchCase` on every `text` predicate, and an older page rejects a query field it does not know, so `{kind:"text"}` answered a false "no" while `reticle_look find` found the element. The engine now sends `matchCase` only to a page on 3.7.0 or newer. An older page compares text without case, as it did before 3.7.0; update the page's SDK for case-exact checks.
