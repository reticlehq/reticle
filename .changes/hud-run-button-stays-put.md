### Fixed

- **`@reticlehq/browser` — the HUD's Run Harness button blinked out and back while a run started and updated.** Every push from the daemon rebuilt the Harness rows and the account control, so Run, Stop and the Harness switch were destroyed and recreated on each step, and an open account menu snapped shut. The button now stays in its slot and changes in place: Run → Starting… → Stop → Run. The account menu stays open across updates.
