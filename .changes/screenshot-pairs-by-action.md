### Fixed

- **A run's screenshots went unpaired when one check took no picture.** Pictures were paired with checks by position, and only when the counts agreed, so one check from `reticle_act{steps}` or one answer refused as an error left every issue in the run without its screenshot. Each verdict picture now names the journal action it was taken for, and so does each check (`actionId`, an optional field on both, kept on this machine), so they pair exactly; positional pairing remains for runs written before.
