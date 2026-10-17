### Fixed

- **`@reticlehq/server` — `reticle_session { action: "account" }` could tell a linked project to "press Link this project".** It read the link of the folder the daemon started in, not of the tab's own project, as the Harness does. A daemon started outside the app answered "not linked" for a linked tab. It now reads the tab's project's link. When that cloud does not answer, it names the cloud, says the project is still linked, and asks the user to check the connection.
