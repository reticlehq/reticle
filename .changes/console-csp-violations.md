### Fixed

- **`@reticlehq/browser`: the console channel sees Content Security Policy violations.** The browser never routes a CSP violation through a console method, so DevTools could show dozens of them while `reticle_assert({ kind: "console", level: "error", absent: true })` passed. An enforced violation is now a console error naming the directive and what it blocked. A report-only one, which blocked nothing, is a warning. Contributed by @vaibhav8a in #751.
