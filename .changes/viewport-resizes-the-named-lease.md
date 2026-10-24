### Fixed

- **`reticle_viewport` said `applied: true` while the named tab kept its old size.** With a driven browser running, a call that named a leased tab resized the driven tab instead. An agent then read desktop layout boxes as mobile ones. A `sessionId` that names a lease now resizes that lease only. On a lease, the result carries `observed`, the size the page reports after the resize, and `applied` is `false` when that size does not match the request.
