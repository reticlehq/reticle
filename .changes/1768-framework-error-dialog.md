### Fixed

- **`@reticlehq/browser`, `@reticlehq/engine` — a check under a framework error dialog no longer answers `yes`.** Reticle ignores the Next.js dev overlay, so a `text` or `element` check on content under an open Next.js error dialog passed while the user saw only the dialog. The Vite error overlay had the same effect. A match under an open Next.js error dialog or Vite error overlay now answers `unknown`, and the reason names the dialog. The Next.js toast and dev-tools button stay ignored. Closes [#1768](https://github.com/reticlehq/reticle/issues/1768).
