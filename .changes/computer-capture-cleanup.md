### Fixed

- **`@reticlehq/computer` — pictures of the screen stayed in the temporary folder.** On macOS each picture the realm took was a file in the temporary folder, and only the daemon deleted it, after it read it. A picture the daemon never read (a command that timed out, a read that failed) stayed there for good. The realm now removes every picture it wrote when it stops.
