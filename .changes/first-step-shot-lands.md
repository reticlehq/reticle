### Fixed

- **`@reticlehq/server` — a session's first step screenshot was named and never landed.** The first capture of a tab is now tried again once if it fails (the in-page renderer loads on first use) and waited for, so its answer is a path that exists or the reason there is none.
- **`@reticlehq/server` — "you have driven 1 step by hand" after twenty.** The count was kept per agent connection, which a client may open per call; the nudge no longer claims a number it cannot know.
