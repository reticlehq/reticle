### Added

- **`@reticlehq/server` — a chat-requested drive's result now says whether it was filmed.** A drive in your own tab, which only the SDK reaches, has no camera, so the chat showed no video and no reason. The result the daemon reports carries `filmed: boolean` — true only when at least one picture reached the platform — so the platform can say why there is nothing to watch.
