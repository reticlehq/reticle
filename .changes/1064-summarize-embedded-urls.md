### Fixed

- **`@reticlehq/core` — embedded image URLs could flood diagnostic output with base64 data.** `data:` and `blob:` URLs are now reduced to a bounded summary that keeps the media type and byte count without carrying the payload into the agent transcript. Closes [#1064](https://github.com/reticlehq/reticle/issues/1064).
