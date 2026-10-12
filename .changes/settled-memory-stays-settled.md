### Fixed

- **`@reticlehq/server` — a maintainer's decision on the dashboard was undone by the author's own daemon.** After she chose the author's words (now agreed), the author's machine still held them as `proposed`, re-sent them every few seconds, and the platform took the author's copy. A status the team settled on the same words is now brought down to the local record (raised only, never lowered), so nothing re-sends them as proposed.
- **`@reticlehq/server` — a check bound to words that were set aside stayed bound to the words that replaced them,** so a later green on it would "prove" words it never tested. New words keep no check bound to the old ones.
