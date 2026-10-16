### Added

- **`@reticlehq/server`: the daemon accepts a single-use session nonce in a HELLO.** A page on an origin that cannot hold the machine's pairing token (a production site) can now connect with a nonce that a local caller minted for one drive. The nonce expires after 60 minutes by default. The first tab that presents it owns it: that tab can reconnect after a reload, and any other tab is refused. The bridge admits the nonce's origin only while the nonce is live. Nothing on the bridge socket can mint a nonce.
