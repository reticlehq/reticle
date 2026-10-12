### Fixed

- **A re-linked folder keeps its impact and memory records with its history.** Re-linked from a personal workspace to a company's, a folder held back its old runs but sent its impact record (the previous workspace's counts and defects) into the company's project. The records a folder derives (impact, notes, intents and the rest) add up its whole history, so they now stay on the machine with the runs and flows until `reticle sync --move-history` sends them.
