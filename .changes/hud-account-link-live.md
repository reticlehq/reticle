### Fixed

- **`@reticlehq/server` — the HUD kept showing who was signed in after `reticle logout`, and "Not linked" after `reticle link`.** Both commands run in another process, and the daemon only pushed account state when a tab connected or a tool ran; worse, the link was read once when the daemon first saw the project, so a project linked later said "Not linked" through every reload until the daemon restarted. The daemon now re-reads the link on every snapshot and repaints the HUD within about a second of either file changing.
