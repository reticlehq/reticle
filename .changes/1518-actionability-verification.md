### Fixed

- **`reticle_act_and_wait` and `reticle_act_sequence` could verify a hidden or covered control.** Synthetic browser events can reach a target that a user could not, so those interactions now return an honest unknown result and replay will not report them as successful verification. Closes [#1518](https://github.com/reticlehq/reticle/issues/1518).
