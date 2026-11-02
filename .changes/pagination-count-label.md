### Fixed

- **`@reticlehq/engine` — a count that starts at zero is no longer read as a page label.** A progress label such as "0 of 4 generated" changing to "1 of 4 generated" read as the page moving from 0 to 1. When a list refetched its first page in the same window, `pagination-not-fetched` fired and the verdict read `no`, though no paging action happened. A bare "N of M" with N = 0 is now a count, because no pager shows page 0. The explicit "Page N" form, and real stalled pagination from page 1 on, are still found.
