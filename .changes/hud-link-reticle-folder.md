### Fixed

- **`@reticlehq/server` — Link this project on the HUD could say "Linked" and link nothing.** The HUD passes the tab's `.reticle` folder. On an app with no `.reticle.json`, the link was written to `.reticle/.reticle/cloud.json`, so the page said "Linked", stayed on "Linking…", and the project was still not linked. A link asked for from a `.reticle` folder now binds the project that folder belongs to.
