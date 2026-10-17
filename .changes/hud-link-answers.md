### Fixed

- **`@reticlehq/browser`, `@reticlehq/server` — Link this project on the HUD could stay at "Linking…" with no answer.** When the daemon refused the link (the page names no project, or this daemon cannot link), it said so only in the Agent Log, and the Harness page kept a disabled "Linking…" button until a reload. The answer now shows on the Harness page too, and the button comes back after 20 seconds if no link lands.
