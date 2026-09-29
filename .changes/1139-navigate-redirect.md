### Fixed

- **`@reticlehq/server` — `reticle_navigate` could report a navigation as unconfirmed when the application redirected the browser to another page.** Reticle now reports the URL where the navigated document landed, including when the document reconnects under a successor session, so agents can distinguish a redirect such as `/checkout` → `/login` from a navigation that never arrived. Closes [#1139](https://github.com/reticlehq/reticle/issues/1139).
