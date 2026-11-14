### Fixed

- **`@reticlehq/engine` — a `settled` check never passed on a page where an attribute was written again with the same value.** A page with a hidden input whose inline `style` was set, unchanged, every 1-3 seconds read as still active, so `settled` answered "not settled: last activity (dom.attr)" on a page that had stopped. An attribute write that leaves the value as it was is no longer activity, for `settled` and for the route-settle check. A write that changes the value still is. An SDK that does not report the old value keeps counting every write.
