### Added

- **`@reticlehq/core` + `@reticlehq/browser` + `@reticlehq/engine` — a check can now assert on the page's `<head>`.** "Add a favicon" or "set the meta description" was a change no predicate could verify: every locator matches by role, text, label or test id, and a `<link>` or `<meta>` has none of them. `{ kind: "head", link: { rel: "icon" }, href: { contains: "icon.svg" } }` and `{ kind: "head", meta: { name: "description" }, content: { contains: "…" } }` now pass or fail on the live head, including tags a head manager sets after load. What Reticle cannot see answers `unknown`, not `fail`: an older SDK, a value redacted or shortened before it left the page. Closes [#1425](https://github.com/reticlehq/reticle/issues/1425).

### Security

- **`@reticlehq/core` — a bare `_csrf`, `csrf` or `xsrf` key is now redacted everywhere, not only in the head.** The shared key rule caught `csrf-token` and `csrf_token` but not the bare name, so Spring Security's `<meta name="_csrf">` and csurf's `_csrf` cookie could reach an agent through a storage or cookie read, a captured request body, or (with this change) a head read. The rule is shared, so every one of those paths now redacts them.
