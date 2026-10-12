### Fixed

- **The session list no longer says "this daemon has never seen one" about a tab it last saw.** After a leased tab was reaped, `reticle_session {list}` said the daemon had never seen a session and advised starting the dev server, while a call on the old id answered "Last seen on http://localhost:…". A tab that reported no project cannot be another project's: the daemon's own last tab now answers both.
