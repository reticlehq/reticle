### Fixed

- **`@reticlehq/server` — the Harness setup score depended on which tab of an app reported.** Of two tabs of one app, the one with more channels spoke alone, so a test id seen in one tab and source mapping seen in another counted as neither. The report to the dashboard now merges the channels and gaps every tab of the app has seen.
