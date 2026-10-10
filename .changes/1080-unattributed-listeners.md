### Changed

- **`@reticlehq/server` — Clarify that unattributed port listeners may not be this app.** When ports are actively serving pages without an active session, diagnosis and next-action messages now make it clear that those listeners may belong to unrelated applications rather than assuming they belong to the current project. Fixes [#1080](https://github.com/reticlehq/reticle/issues/1080).
