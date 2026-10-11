### Changed

- **`@reticlehq/browser`, `@reticlehq/server` — the HUD shows your plan and keeps up with the platform.** Signed in, the account menu now shows your plan (and trial days left), Harness credits left, and how many runs the dashboard holds for this project; when the platform reports them, Harness runs and memory entries too. The daemon re-checks every open tab every 30 seconds and repaints only what changed, so an idle tab no longer waits for a tool call to catch up.
