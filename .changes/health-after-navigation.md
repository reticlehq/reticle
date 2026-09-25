### Fixed

- **`@reticlehq/server`: `reticle_navigate` confirms a navigation given as a path.** `{ url: "/orders?id=4" }` answered `confirmed: false` after its whole wait, even when the tab arrived there almost at once. The arrival check could not parse a relative URL, so it never matched. The target is now resolved against the tab being navigated, the same way the browser resolves it.
- **`@reticlehq/server`: a tab is no longer reported throttled straight after a navigation.** A page that unloads reports itself hidden on the way out, and the `session` block on the response was read from that departed page. Every call that crossed a full navigation or reload said "tab throttled" about a tab that was fine. The block now describes the page registered under that session now.
