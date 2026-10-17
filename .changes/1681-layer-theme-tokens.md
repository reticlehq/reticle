### Fixed

- **`@reticlehq/browser` — design tokens declared inside `@layer` (Tailwind v4), `@media` or `@supports` were invisible to the theme check.** Token discovery read only top-level style rules, so on an app whose tokens live in `@layer theme { :root { … } }` every inspect reported `tokenCount: 0` and the `offTheme` check never ran. Token discovery now descends into any grouping rule, with a depth bound that keeps a pathological stylesheet cheap. Closes [#1681](https://github.com/reticlehq/reticle/issues/1681).
