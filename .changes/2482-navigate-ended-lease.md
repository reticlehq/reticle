### Fixed

- **`@reticlehq/server` — `reticle_navigate` on a lease that ended during the navigate waited out the whole window and said the lease was kept.** The answer said the page had no Reticle SDK and that the lease was kept, while a screenshot in the same answer said the lease had ended. An agent then navigated a lease that no longer existed. Navigate now stops waiting when the lease ends, answers `ok: false`, says that the lease ended, and names `reticle_lease { action: "acquire" }`. Closes [#2482](https://github.com/reticlehq/reticle/issues/2482).
