### Fixed

- **`@reticlehq/server`: cloud pushes no longer report success when artifacts are rejected.** `reticle push` and `reticle sync` now return `ok: false` and exit `1` when the cloud refuses any offered run, including partial rejections. Accepted counts, rejection reasons and pulled decisions are preserved. Fully accepted and already-up-to-date syncs still succeed. This addresses the local false-success report in [#989](https://github.com/reticlehq/reticle/issues/989), not the remote service's artifact-schema validator. Contributed by @DivyamTalwar in #1012.
