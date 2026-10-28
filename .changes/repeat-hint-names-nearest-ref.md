### Changed

- **`@reticlehq/server` — a repeated missed target now points at the nearest ref.** On the third identical call that matched no element, the repeat hint told the agent to take a `reticle_look { action: "find" }`. The refusal already lists the nearest targets with refs, so that advice cost one more call. Now the hint says to pass one of those refs as `ref`, and names the first one. When the refusal lists no nearest targets, the hint still advises a `reticle_look { action: "find" }`.
