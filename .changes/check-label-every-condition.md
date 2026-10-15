### Fixed

- **`@reticlehq/engine` — a weaker passing check closed a stricter check's issue while the defect was live.** A check's title left out its status, count and body conditions, so "an order request fires" and "the order request carries the promo code" had the same title and the same issue. The plain check passed and resolved the issue for the promo code. A check's title now names every condition it checks, so the two stay apart.
