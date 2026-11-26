### Fixed

- **`@reticlehq/computer` — a control in a panel that the hit test does not see is no longer refused as covered.** On macOS, when the hit test answers with the target's own window, no part of the window is over the target. Dia's profile list in its sidebar was refused as "covered by the window". Another element over the target is still refused.
