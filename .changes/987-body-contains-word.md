### Fixed

- **`@reticlehq/engine` — `net.bodyContains: "completed"` passed on a queued job.** The letters sat inside the key `completedAt`, so the verdict was yes while `status` was `queued`. A needle made only of letters, digits and underscores now has to be a whole word, and `bodyMatches` compares JSON values the way `requestBodyMatches` already does for the request. `{ bodyMatches: { status: "completed" } }` cannot be satisfied by a key name. Closes [#987](https://github.com/reticlehq/reticle/issues/987).
