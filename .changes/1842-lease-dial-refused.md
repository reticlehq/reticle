### Fixed

- **A lease whose page dialled and was refused said the SDK never dialled.** The hint already named the refusal. `notReadyReason` now says `sdk_dial_refused`, and the hint still carries the cause, so the next step is the refusal rather than a fresh install. A wait with no dial is still `sdk_never_dialled`. See [#1842](https://github.com/reticlehq/reticle/issues/1842).
