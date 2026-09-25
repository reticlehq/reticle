### Added

- **`@reticlehq/server` — a project can name its own background traffic.** `.reticle.json` takes `"background": ["/api/analytics/events", "/api/heartbeat"]`, matched the way `urlContains` is. A listed request stops holding a verdict's wait open and stops contradicting an unrelated claim; an assertion that names it still sees it. Same-origin telemetry looks exactly like the app's work, so Reticle never guesses at it. Signing in with a held analytics ping in flight went from `unknown` after the whole 8s budget to `yes` in 20ms.

### Fixed

- **`@reticlehq/server` — a third-party beacon that never answers no longer stalls every passing `act_and_wait`.** The verdict already ignored somebody else's traffic, but the wait before it did not, so a hung vendor request cost the action's whole remaining timeout before the verdict set it aside.
