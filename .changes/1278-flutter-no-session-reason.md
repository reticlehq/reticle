### Fixed

- **`@reticlehq/server` — session list reported missing dev script in Flutter projects.** When inspecting a Flutter web project (`pubspec.yaml` present, no `package.json`), `reticle_session` with `action: "list"` reported that the project declares no dev script. The session-list next-action path now reuses non-JS ecosystem detection from `@reticlehq/init` so that the reason names Flutter and explains why canvas-based rendering cannot be instrumented. Closes [#1278](https://github.com/reticlehq/reticle/issues/1278).
