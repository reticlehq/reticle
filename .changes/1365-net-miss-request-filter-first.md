### Fixed

- **`@reticlehq/engine` — a `net` miss on a multiplexed endpoint explained itself with an unrelated call.** With `requestBodyMatches` selecting one query on an endpoint that serves many, the failure's `observed` showed the response of whichever other query came first, so it looked as if the request filter had not isolated the call. Pass and fail were already correct. The response side is now only reported from a call that matched the request clause. Closes [#1365](https://github.com/reticlehq/reticle/issues/1365).
