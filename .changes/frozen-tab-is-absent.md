### Fixed

- **`@reticlehq/server` — `verify --expect <url>` and `reticle open` drove a frozen tab.** A tab the SDK had last been heard from 105 seconds earlier still counted as "already open", so the verdict came back `unknown — command 'match' timed out after 8000ms` instead of the url being opened, and a lease's `preferExisting` pointed at the same dead tab. A tab silent past the daemon's own staleness threshold now counts as absent.
