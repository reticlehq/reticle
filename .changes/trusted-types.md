### Fixed

- **`@reticlehq/browser` — a page that requires Trusted Types connects.** On such a page (Slack is one), the reader mounted its page annotator with `innerHTML`, the browser threw, and `connect()` stopped before it dialled the bridge. Reticle's page UI now writes its HTML through a Trusted Types policy named `reticle` (never the page's `default` policy), and a page UI that still cannot mount no longer stops the session.
