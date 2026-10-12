### Fixed

- **A run held back from a new link is not also "waiting to be sent".** `connect --workspace` ended with "not sent: 1 run … run `reticle sync --move-history`" and then "1 run(s) in this folder are waiting to be sent: run `reticle sync`" for the same run, and a plain sync never sends it. Runs made before the folder was linked to its workspace are no longer counted as waiting, so the one instruction left is the right one.
