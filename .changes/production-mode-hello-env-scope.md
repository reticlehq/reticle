### Added

- **`@reticlehq/core`, `@reticlehq/browser`, `@reticlehq/server`: a HELLO can say where the page runs and what a drive may do there.** `reticle.connect({ env: "production", scope: "observe" | "act" })` sends both in the HELLO. Both are optional, and an older SDK that sends neither connects as before. The daemon accepts a production HELLO only with a production session nonce, never with the machine's pairing token, and a production HELLO must name its scope. The nonce decides the scope: a page can narrow `act` to `observe` and cannot widen it.
