### Added

- **`@reticlehq/server` — a reply address on feedback, sent only when you give it.** `reticle feedback --contact you@example.com "..."` adds one email address so that the maintainers can answer you. Your agent can pass one on with `contact` on `reticle_session { action: "feedback" }`, but only an address that you typed for this purpose. An address that is not one plain email address is refused, and nothing is filed. Without the flag, no address is sent.
