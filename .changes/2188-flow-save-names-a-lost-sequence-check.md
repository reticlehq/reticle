### Fixed

- **`@reticlehq/server` — saving a `reticle_act_sequence` journey could lose a check and say nothing.** A sub-step `expect` that names a session ref (for example `scope: "e12"`) cannot be saved, because a ref does not live past the session. For a single act, `reticle_flow_save` said that the flow does not keep that check. For a sub-step of a sequence, it dropped the check silently, so the saved flow checked less than the drive proved. The save now gives the same warning for a sequence. Closes [#2188](https://github.com/reticlehq/reticle/issues/2188).
