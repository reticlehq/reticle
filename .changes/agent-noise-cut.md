### Fixed

- **The "yield the panel" reminder no longer appears in CI output** (`CI` set): there is no panel and nobody to hand it back to.
- **A failed `reticle_assert` no longer says "the control that was driven carries no source mapping"** — an assertion drives nothing. It now says "nothing this verdict located carries a source mapping".
- **An ordinary refusal no longer carries the founder's calendar link.** It stays for an agent stuck on the same call and at a session's end; the feedback invitation itself is unchanged.
- **`@reticlehq/browser` — an empty password field read `[value="[REDACTED]"]`,** which says "has a value". It now reads empty; a typed value is still redacted.
