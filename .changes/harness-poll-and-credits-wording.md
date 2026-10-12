### Changed

- **`@reticlehq/server`: an agent stays with a Harness drive.** A `reticle_verify { action: "explore", runId }` poll waits up to 50 seconds by default and returns the moment the drive ends. While the drive runs, the answer carries its steps, elapsed time, last action and the exact call to repeat, and says the drive keeps running if the agent stops. A drive started from the HUD is announced on the agent's next tool call with its runId, and its result when it ends.
- **The Harness allowance is named in credits again** in the HUD, CLI and docs ("47 of 50 credits left").
