### Fixed

- **A session end counts the replays the session ran.** A session whose only work was a failing `reticle_verify {action:"flows"}` replay ended "Reticle result: not proved · nothing was checked", beside the replay's own "1 of 1 check did not hold". Each replay is now one check of the session that ran it: held when it replayed clean, failed when a step failed, undecided when it drifted or its flow asserts nothing.
