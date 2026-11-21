### Fixed

- **`@reticlehq/server` — a drive whose write request was blocked was auto-saved as a flow that sends the write for real.** An agent blocked a POST outside Reticle and drove Save, so nothing was written. Session end saved the drive as a flow, which kept the click and not the block, so its next replay sent the real POST. A write request that failed at the network level (`status: 0` with an error) is now read as blocked, and its journey is left out of the auto-save, as a drive run against network mocks already is. Closes [#2321](https://github.com/reticlehq/reticle/issues/2321).
