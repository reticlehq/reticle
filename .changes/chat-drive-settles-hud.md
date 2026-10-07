### Fixed

- **`@reticlehq/server` — after a drive requested from the platform chat finished, the HUD kept saying "planning next action" and counting.** No agent was attached to end the session, so the panel treated the finished drive as an agent still thinking. The daemon now ends the driven tab's session when the drive is over, with a line saying whether it proved anything; the next agent or drive on that tab picks it back up.
