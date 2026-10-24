### Fixed

- **`@reticlehq/server` — a page on an older SDK was named only once.** A page whose SDK was a minor release or more behind the daemon connected and verified, but it lacked the commands and fixes added since. The agent heard this on one tool result, and then never again. `reticle_session { action: "list" }` now shows `sdkVersion` for each tab, and `sdkBehind` with the update command when the page is behind. Each verdict on such a page carries a short `sdk_behind` note.
