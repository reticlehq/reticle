### Added

- **`@reticlehq/computer` — the package holds the Mac programs, built for Apple silicon and Intel.** `prepack` builds the helper and the HUD, so a person who installs the package needs no Swift compiler. Each program is signed with a Developer ID when `APPLE_SIGNING_IDENTITY` is set, and ad hoc otherwise. The HUD source is in the package too: before, the HUD could not be built from an installed package. `reticle-computer` no longer tries to build a Swift program on Linux.
