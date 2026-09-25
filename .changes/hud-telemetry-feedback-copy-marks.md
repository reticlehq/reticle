### Added

- **`@reticlehq/browser` + `@reticlehq/server`: the HUD reports how it is used, as control names only.** Every press on the HUD is counted by the control's own name, along with how long the HUD sits as a bubble, collapsed or expanded, which panel is open, which settings are switched and to what, and the order it all happened in. It rides the session summary like the tool counts do, is off whenever telemetry is off, and carries no page text, flow names or URLs: the daemon drops any control name it does not know. A person's clicks on Reticle's panel never reach the evidence a verdict is built from. See `docs/telemetry-contract.md`.
- **`@reticlehq/browser`: Settings has two ways to reach the founder.** "Email the founder" opens a mail to hey@reticle.sh, and "Book a call" opens the booking page.
- **`@reticlehq/browser`: annotations can be copied for an agent.** A mark reaches the agent connected to the page; with none running, notes stayed on screen and went nowhere. Once there is a note, the chat panel shows how many and a "Copy for your agent" button, which puts every note on the clipboard as one prompt, with the element, its source file when the app is stamped, and the page. Paste it into any agent. "Clear on copy/send" clears the marks after, as it does for a run.

### Fixed

- **`@reticlehq/browser`: toolbar tooltips drew behind the chat and settings panels.** The HUD block is a stacking context, so a tooltip's z-index only ranked it inside the block. The block now rises while a tooltip can show.
