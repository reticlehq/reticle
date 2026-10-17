### Fixed

- **`@reticlehq/browser`, `@reticlehq/core` — the HUD's plan and set-up links opened a 404 when the API and the console are on different origins.** The HUD built "Add a card…", "See plans" and "Set up" from the API's origin. The platform already sends the console's own plan page as `planUrl`, but the HUD's schema dropped it. The HUD now links to that page, and set-up to the same origin.
