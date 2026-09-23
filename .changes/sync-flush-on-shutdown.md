### Fixed

- **`@reticlehq/server` — a drive's last run never left the machine.** The daemon's shutdown cancelled the sync it had just scheduled. A session's run artifact is written at teardown, which schedules a push 1.5 seconds later; `close()` then cleared that timer and the process exited. For an ordinary drive — a CI run, an agent that finished, a daemon that idled out — the evidence the whole session produced stayed on disk, and the dashboard showed the work of every session except the one you just ran.

  Shutdown now flushes instead of cancelling: a cycle already in flight is waited out (bounded, so closing can never hang) and one final cycle runs before the process exits. Nothing about the interval, the nudge or the ask-then-send protocol changed.
