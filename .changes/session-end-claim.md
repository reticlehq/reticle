### Added

- **`reticle_session { action: "end", claim: "pass" | "fail" | "partial" }`** states the agent's own claim. The answer sets it beside the grade of the session's checks (`claim: { claimed, graded, agrees }`), and the run artifact carries it as `agentClaim`, never as the verdict.
