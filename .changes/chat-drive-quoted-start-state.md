### Fixed

- **A chat-requested drive no longer reports a working feature as "Failed" because its request quoted the starting state.** Asked to check that a button goes from "Count is 0" to "Count is 1", the drive looked for every quoted text on the page it ended on, did not find "Count is 0" (correctly gone), and called the drive refuted. A quoted text missing at the end now only stops the drive from passing; it is reported as not proved, never as a failure.
