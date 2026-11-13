### Fixed

- **`@reticlehq/server` — `reticle_navigate { reload: true, hard: true }` fetches every script and module again on a leased tab.** The hard reload only added a query parameter to the page URL. The document was fetched again, but scripts and ES modules came from the browser cache, so an edited module stayed stale. A leased tab now reloads through the browser with the cache ignored, as Cmd+Shift+R does. On a tab that Reticle does not drive, the page can still fetch only its document. The result says which one happened in `hardReload`, and its note gives the fix.
