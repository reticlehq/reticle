### Changed

- **`@reticlehq/server`: the agent is told to read what Reticle already knows before it tests.** The MCP server's instructions now point the agent at the project memory (flows, issues, past runs) and at `reticle_session { action: "account" }` (plan, credits, Harness) before testing. The feedback paragraph says the same in fewer words, so the instructions stay inside their size cap.
