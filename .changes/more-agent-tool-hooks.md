### Added

- **`@reticlehq/init`, `@reticlehq/server` — Windsurf, Copilot CLI and Factory Droid tool calls are kept in the episode log.** Each hook follows the vendor's hook reference as of 2026-10-18:
  - Windsurf: `post_run_command` and `post_write_code`. Windsurf sends no result, so none is recorded. Its `model_name` is the model, unless it says "Unknown".
  - Copilot CLI: `postToolUse` for `bash` and `edit`. A `toolResult` that is not `success` is recorded as a failure.
  - Factory Droid: `PostToolUse` for `Execute`, `Edit`, `ApplyPatch`, `Create`, `FetchUrl` and `WebSearch`.

  VS Code reads `PostToolUse` from the same file as Copilot CLI, but its reference gives no input fields, so nothing is written for it.
