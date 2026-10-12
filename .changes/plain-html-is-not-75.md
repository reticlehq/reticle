### Fixed

- **`@reticlehq/browser`, `@reticlehq/server` — a plain-HTML app was held at 75% ("File and line") and its Harness stayed locked for good.** A page with no build plugin, no component framework and no source stamp now says file:line cannot apply there; it is left out of both sides of the setup score, on the daemon and on the platform, until a stamp shows up.
