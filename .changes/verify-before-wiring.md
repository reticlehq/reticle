### Fixed

- **`@reticlehq/server`: in a project that is not wired yet, the agent now checks its change in the browser instead of skipping it.** The first instructions said no tool could see the app until `init` ran, so agents wrote a throwaway Playwright script or did not check at all. They now name the zero-install lease, which opens the running app with Reticle's own reader and changes no file. `init` stays the way to wire the app for good.
