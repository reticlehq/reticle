### Fixed

- **`@reticlehq/computer` installs from npm, with its Mac programs.** It needs the file snapshot of the command-line realm, and that package was private, so an install of `@reticlehq/computer` would have failed. The command-line realm is now published as **`@reticlehq/terminal`** (it was `@reticlehq/cli-realm`, never published), with the command `reticle-terminal`. The publish now builds the Mac helper and HUD on a Mac and puts them in the package, so a Mac user needs no Swift compiler. Before, the publish ran only on Linux and built neither.
