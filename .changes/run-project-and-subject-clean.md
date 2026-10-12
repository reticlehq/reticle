### Fixed

- **A run names its project and its page as the app does.** A run from a tab that reported no project was stamped with the project "reticle-mcp" (the daemon's own name), and its subject URL repeated `__reticle_session=…` up to three times. The project is now named by its folder when the tab named none, and a run's subject is the app's address without the parameters Reticle put on the tab.
