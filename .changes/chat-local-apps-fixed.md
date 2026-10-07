### Fixed

- **`@reticlehq/server` — a window opened with `reticle drive` never appeared in the platform's chat, and its drives had no pictures.** That window runs in a process that never started the chat's side, and its pages were neither a pool lease nor a desktop window, so nothing filmed them. Both now work as they do for the daemon.
- **`@reticlehq/server` — a Harness journey that said where it ends was failed on an app that got there.** Asked to click a counter and "confirm it now reads "count: 1"", the drive clicked with nothing declared to check, held no check, and the journey failed. A journey that quotes its end state is now judged by checking that end state on the page.
