### Fixed

- **A step that declared a failed request was still graded `no`.** In `reticle_act { steps }` and in flow replay, a step could expect a refusal, for example `expect: { kind: "net", method: "POST", status: 409 }`. The expectation held, but the step answered `no` with `ui-advanced-request-failed`, and a replayed flow became `unverifiable`. The same check in `reticle_act_and_wait` answered `yes`. Each step now gives the contradiction rules the failures it declared. A failure that no step declared is still reported. Closes [#1806](https://github.com/reticlehq/reticle/issues/1806).
