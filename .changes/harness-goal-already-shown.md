### Fixed

- **`@reticlehq/server`: a Harness goal the page already showed is never proved.** A drive asked to check that the page shows "Compose" reported the goal `verified: yes` and synced as Passed, because "Compose" was a sidebar label before the drive did anything. The Harness now reads the page before it drives; a quoted goal already on it is not checked, comes back not proved, and the answer says why. A drive whose quoted goal is not proved no longer syncs as Passed because a click held on the way: it syncs as partly passed.
