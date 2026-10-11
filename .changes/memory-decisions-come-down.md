### Fixed

- **`@reticlehq/server` — a maintainer's memory decision never reached the author's computer.** When a maintainer kept the team's words and set an author's aside, the author's own record still said hers, agreed, and her daemon re-sent them every cycle as a new disagreement. Each sync of a project with memory sync on now brings the decisions down: a local record whose words were set aside takes the words that were kept, and says who decided.
