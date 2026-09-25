### Fixed

- **`@reticlehq/server`: a page that does not answer is `unknown`, not a failed check.** When reading the page failed partway through a wait (a command that timed out on a busy or throttled tab, or a page that went away), the wait reported the claim as not holding. `reticle_assert` and `act_and_wait` then answered `verified: "no"` about a page that was never read. Such a read is now inconclusive and comes back `unknown`, naming what did not answer.
