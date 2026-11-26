### Fixed

- **`@reticlehq/computer` — `narrate` reaches the HUD of a desktop session.** The realm showed narration, but it did not declare the command when it joined, so the bridge refused it ("this page does not serve narrate"). The person watching saw each action and never what the agent meant to do. The answer now says whether a HUD showed the text.
