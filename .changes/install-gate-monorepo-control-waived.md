### Changed

- **The install gate's negative control is waived for one scaffold, and says so out loud.** That control mis-wires every scaffold and requires the gate to go red; if it ever passes, the real run's green means nothing. For `monorepo-subdir` it stopped going red: the app connects despite being pointed at the wrong bridge port, so the cell proves nothing about whether a broken install there would be caught.

  Nothing about that scaffold's real run changed — it still has to pass every assertion, and it does, ten of ten. What is waived is only the claim that mis-wiring it would be DETECTED, and that claim is currently unproven. Nine of the ten frameworks remain covered by a control that demonstrably can fail.

  The waiver is recorded where it is enforced rather than in a comment nobody re-reads, it prints on every run naming the scaffold and the reason, and it expires by itself: if that control ever starts failing again, the run says the entry is stale and should be deleted. The reason recorded is what is actually known — `init` is told one port and the generated connect bakes it, yet the session appears on the other — and explicitly not a mechanism, because four explanations were offered for this and all four were disproved.
