### Changed

- **`@reticlehq/server` — shared memory is read a page at a time.** `reticle_memory`, flow replay, `reticle memory` and the sync read all of `GET /v1/memory` in one response, which grows without bound with a project's memory. Each now asks for pages of 100 and follows `nextCursor`. A server that does not page answers once with everything, as before. A read that reaches the page ceiling says `truncated: true`.
