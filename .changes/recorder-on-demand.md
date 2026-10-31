### Changed

- **`@reticlehq/browser` — the recorder loads only for a page that asks to record.** The recorder installs only with `connect({ recorder: true })`, but every page downloaded it on load: about 7.5 KB, measured 7,518 B. It now loads with a dynamic import when a page asks for it, and it mounts only if the page is still connected when it arrives. A page's first load of the SDK is now about 7.5 KB smaller.
