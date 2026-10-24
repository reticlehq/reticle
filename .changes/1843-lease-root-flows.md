### Fixed

- **A lease opened with `root` listed another worktree's flows.** The claim named the folder, and flow listing still followed the page origin, which two worktrees of one project share. Listing and replay now read the claimed folder first. See [#1843](https://github.com/reticlehq/reticle/issues/1843).
