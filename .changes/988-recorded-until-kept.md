### Fixed

- **`@reticlehq/server` — a recorded flow lost the `until` that `act_and_wait` proved, and replayed with no check.** Three paths dropped the claim:
  - When an `act_and_wait` failed, the claim of the step BEFORE it came off the always-on recording, though that step had passed.
  - A claim that the action made hold was dropped when the verdict was not a clean `yes`, for example `unknown` or a contradicted verdict.
  - In a recording that you started with `reticle_record`, a claim that did not hold was dropped. The saved flow then passed on the defect that the drive had found.

  A recording that you start now keeps every claim that you declared. The always-on recording keeps each claim that the action made hold. Absence (`absent: true`) and `scope` already reached the saved flow, and tests now keep them there. Refs [#988](https://github.com/reticlehq/reticle/issues/988).
