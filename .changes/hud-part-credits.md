### Fixed

- **`@reticlehq/core` — a workspace that had spent part of a credit lost its whole HUD.** The platform charges part credits (a check can cost 0.25), but the HUD's snapshot schema accepted only whole numbers. One `52.25` failed the whole impact snapshot, so the HUD showed no account, no Harness row and no switch, on every page of that project, until the balance was a whole number again. Credits used and the limit now take any number from 0 up.
