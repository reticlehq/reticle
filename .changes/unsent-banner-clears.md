### Fixed

- **`@reticlehq/server` — the dashboard kept saying runs were "never sent" after they had been sent.** Once a folder's runs were all sent, the daemon left the list out of its report, and the platform keeps the last word when the list is absent, so a monorepo's apps showed a false "never sent" banner that did not clear. The daemon now reports an empty list once it has counted.
