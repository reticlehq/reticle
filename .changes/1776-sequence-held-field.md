### Fixed

`reticle_act_sequence` description now names `steps[i].held` (true | false — the per-step verdict), `observed` (why a step missed), and `stopped_at` (the index of the first miss), so agents do not need to infer success from `tail: null`.

Closes #1776
