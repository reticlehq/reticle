### Fixed

- **`@reticlehq/server` — a replay with a missing secret typed the placeholder and reported `drift`.** A sign-in recorded as one sequence kept its password fill in a sub-step, and the check that refuses a replay with an unsupplied secret read only top-level steps. The replay went ahead, typed `<redacted: supply at replay>` into the password box, and blamed a later step. It now finds a redacted fill inside a sequence too, returns `unverifiable` before any step runs, and names the variable to set.
