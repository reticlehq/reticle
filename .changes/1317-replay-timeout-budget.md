### Fixed

- **`@reticlehq/server` — recorded action timeout budgets were lost during flow replay.** Slow actions and multi-step sequences could time out at replay's shorter transport default even when the live recording used a longer `timeout_ms`; saved steps now retain their explicit budget, and batched sequences receive the combined budget for their sub-steps. Closes [#1317](https://github.com/reticlehq/reticle/issues/1317).
