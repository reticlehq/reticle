### Fixed

- **`@reticlehq/browser`, `@reticlehq/engine` — a text check that missed only on case was called "split across the children" and told to retry the same check.** A case-exact check whose text the page shows in another case now says what the page shows and that `ignoreCase: true` matches it; the "split" hint only fires under the check's own case rule.
