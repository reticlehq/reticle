### Fixed

- **`@reticlehq/server` — the recovery hint for a throttled tab, a hover or a timed-out command told the agent to make a call that is refused.** It said `reticle_run { tool: "reticle_lease", action: "acquire", url }`, and `reticle_run` answers that with "Unknown parameters for reticle_run: action, url", so an agent that followed the advice exactly spent its retry on a refusal. Every hint now gives the working shape, `reticle_run { tool: "reticle_lease", args: { action: "acquire", url } }`, and each example we ship is checked against `reticle_run`'s real input schema.
