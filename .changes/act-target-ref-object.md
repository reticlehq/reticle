### Fixed

- **`@reticlehq/server` — `target: { ref }` failed with "Nothing was searched".** When a target matched more than one element, the refusal said to pass an explicit `ref`. An agent that put the ref inside the target object (`target: { ref: "e12" }`) got a refusal that said the query named nothing. `reticle_act` and its steps now read `target: { ref }` the same as a top-level `ref`, with the same check that Reticle issued it.
