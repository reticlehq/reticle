### Fixed

- **Claude Code plugin — an install in an open session never got the first-session offer.** The plugin's hook ran only when a session started, and `/reload-plugins` starts no session. So the agent never offered the check that installs nothing, or asked to wire the app. Now the first tool call of each agent connection carries the same offer once, in `first_session_offer`, when the web app is not wired and no app is attached. The hook also runs after `/clear`, compaction and resume. It still says the offer once for each project. The offer never changes a verdict.
