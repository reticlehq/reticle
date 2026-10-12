### Fixed

- **`@reticlehq/server` — a second agent session on a tab showed the first session's request as its "What was asked".** A recorded request rides on the first run written for it (and that run's rewrites), never on the next one.
- **`@reticlehq/server` — the run that proved the words a maintainer kept listed the words she set aside as its goal.** A decision brought down from the dashboard also replaces the set-aside words in the agent's recorded request.
