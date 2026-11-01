### Fixed

- **`@reticlehq/server` — `crawl` no longer clicks a control that has no accessible name.** An icon-only button, such as a per-row trash icon, gave the destructive-action guard no text to classify, so the crawl clicked it. The crawl now skips such a control and lists it in `notJudged` with a reason. Set `confirmDangerous` to include it. Closes [#1668](https://github.com/reticlehq/reticle/issues/1668).
