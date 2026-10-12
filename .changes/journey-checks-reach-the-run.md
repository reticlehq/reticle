### Fixed

- **`reticle_act { steps }` — a journey's checks never reached the record.** Each step's `expect` was graded in the answer and journaled nowhere, so `reticle_session { end }` said "nothing was checked" and no run reached `.reticle/runs/` or the dashboard — a failed check lost on the path the instructions call the default. Every evaluated `expect` is now one check, written exactly as `reticle_act_and_wait` writes its own, and folds into the session result, the run file and the synced run. A session end now also waits for a journey still grading.
- **A step that navigated away (an external checkout page) was graded `no` with "session disconnected".** Nothing was observed, so the step and the journey are now `unknown`, as `reticle_act_and_wait` already says.
