### Fixed

- **`@reticlehq/server` — a saved flow with an absent count failed on replay.** At save, Reticle makes a text check with a live count word-level, so the number can change: `"Open 336"` becomes `Open <number>`. It did the same to an absent check. `{ contains: "3 items", absent: true }` then said that no `<number> items` is on the page, and a page that showed "5 items" failed the replay while the drive had passed. An absent count now stays exact.
