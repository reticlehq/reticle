### Fixed

- **`@reticlehq/server` — a lease opened with `emulate` that names only a width, or only a height, keeps the headless 1440 by 900 for the other side.** The side it left out used to fall back to 1280 by 720, so `emulate: { width: 390 }` gave a 390 by 720 page, not the 390 by 900 that the headless default implies. The tool description now states 1440 by 900.
