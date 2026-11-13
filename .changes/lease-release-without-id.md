### Changed

- **`@reticlehq/server` — `reticle_lease { action: "release" }` no longer needs a `sessionId` when the agent holds one lease.** Agents often sent a release with no id, got a refusal, and had to call again. With no `sessionId`, Reticle now releases the one lease that this agent holds. When the agent holds none or several, the call is refused and names them. Another agent's lease is never released.
