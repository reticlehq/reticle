### Fixed

- **`@reticlehq/browser` — content below the fold of a scrolling area read as hidden.** In an app whose shell clips with `overflow: hidden` around a scrolling main, every element below the fold was graded hidden, so a text check on it came back `hidden_match` / unknown. Content one scroll away is visible; only content the scrolling area itself is cut off from stays hidden.
