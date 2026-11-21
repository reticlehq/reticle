### Added

- **`@reticlehq/server` — a desktop application can join the bridge with no SDK in it.** A realm that reads an application through the operating system joins as a peer, and the tools for a web page then work on it. The Harness (`reticle_verify { action: "explore" }`) gets a prompt for a desktop application: it sends the model to a file, a setting and the clipboard, not to a link or a request. The realm package (`@reticlehq/computer-use`, macOS) is in the repository and is not published yet. It reads an application through the accessibility tree, acts in the background, and, when a caller asks with `args.foreground: true`, uses the real pointer for a double-click, a hover, a drag and the menu bar. For an application with no elements it gives a picture of the window to `reticle_screenshot` and acts at a point of it.

### Changed

- **`@reticlehq/engine` — a signal that an observer saw is evidence for a session with no SDK.** The rule `signal-without-consequence` is for a signal that the application sends about itself. A session of a peer realm has no SDK, so each of its signals is a thing the realm saw from outside: a file that was written, a setting that changed. An action whose only effect is such a signal now gets `yes`. A session with an SDK is judged as before.
