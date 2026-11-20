### Fixed

- **`@reticlehq/server` — a page refused at the origin gate was diagnosed as a closed tab.** When an app had connected once and its page was then refused at the origin gate (for example a multi-tenant app on a `*.test` host), `reticle_session list` and `reticle status` said "a session was connected to this daemon earlier, so the wiring is correct" and told the agent to reopen the app. Reopening is refused again. The fix, `RETICLE_ALLOWED_ORIGINS`, was only in the daemon log. The diagnosis and the next action now name the refused origin and the allow-list.
