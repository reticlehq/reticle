### Fixed

- **`@reticlehq/server` — on Windows, a terminal window flashed about every 15 seconds while a dev server ran.** The daemon looks up which project serves a page with a PowerShell call, and it reads git for the project identity. The daemon has no console, so on Windows each of these calls opened a new, visible console window. The calls now run with a hidden window.
