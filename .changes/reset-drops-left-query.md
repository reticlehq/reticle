### Fixed

- **`@reticlehq/server` — a flow no longer starts on the filter that the previous flow left.** Before each flow, replay reloads the start page. When the tab was already on that page, the reload kept the URL query, so a filter that the previous flow set (`?unused=true`) applied to the next flow, and a correct app failed it. Replay now drops a query that the last replay on that tab left. A query that the caller put there (for example `?next=/dash`) stays.
