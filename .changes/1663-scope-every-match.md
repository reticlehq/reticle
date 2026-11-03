### Fixed

- **`@reticlehq/browser` — a `scope` that matched several elements searched only the first.** A scope on a list of repeated items, such as `[data-testid=message]`, answered `no element matched` for text in every item after the first, and nothing said that the scope matched more than one element. A CSS scope now searches every element it matches. `reticle_query` reports `scopeMatches` when the scope matched more than one element, and a failed check names the count. A ref scope still names one element. Closes [#1663](https://github.com/reticlehq/reticle/issues/1663).
