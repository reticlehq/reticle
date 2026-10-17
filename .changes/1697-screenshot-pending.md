### Fixed

- **`@reticlehq/server` — `screenshot.path` now carries `pending: true` when the file may not yet be on disk.** On the fast path (a second or later capture on the same tab), the path was returned while the JPEG write was still in flight. A caller that copied the file immediately received `ENOENT`. The result now carries `pending: true` in that case so callers know to wait before reading. Closes [#1697](https://github.com/reticlehq/reticle/issues/1697).
