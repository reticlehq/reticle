### Fixed

- **`@reticlehq/server` — a `target` whose exact name missed said only "widen the query".** The browser already knew what that role is really called; the refusal now names it, and says to target by `testid` or `text` when the name carries a part that changes (a menu item reading "billing Last run 1 minute ago" could not be named for more than a minute).
