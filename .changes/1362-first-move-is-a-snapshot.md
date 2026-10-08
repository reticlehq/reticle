### Fixed

- **`@reticlehq/server`: the MCP instructions no longer open with "no app has ever connected" as a present fact.** Instructions are sent once, at the handshake, so an app that connected afterwards, or a handshake answered by the local proxy, left agents acting on a sentence that was no longer true. The lead now reads "when this session started, no app had connected", only a session on this project's own app counts as the proof, and the unprompted first-reply nudge applies only if none is listed. Closes [#1362](https://github.com/reticlehq/reticle/issues/1362).
