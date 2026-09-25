### Changed

- **`@reticlehq/core`, `@reticlehq/server` — a saved flow keeps the assertion the agent wrote.** A step's `expect` is now the predicate itself, stored verbatim, and replay waits on it directly. It used to be converted into a flat struct with one slot per kind, so `allOf` of two network checks saved as one of them, and `anyOf`, `not` and a property assertion on `state` were dropped. A replay then went green for a flow checking less than its author believed. In the benchmark, a flow asserting "exactly one generate request, and never the telemetry endpoint" replayed green against the second bug before this, and red after.

  Flow files move to version 2. Version 1 files are still read, lifted to the same predicate, and never rewritten on read, so a flow committed by a teammate on an older Reticle keeps working. An older Reticle reading a version 2 file says the reader is the wrong version rather than calling the file malformed.

  A saved check that names an element by its session ref (`scope: "e12"`, an animation `target`) is refused with the field named. A ref only exists in the session that minted it, and for an absence check a scope that resolves to nothing passes by construction.
