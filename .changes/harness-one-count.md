### Fixed

- **A Harness answer counts its outcomes once.** "3 of 3 check(s) held" sat beside "Drove 2 action(s): 2 proved", two counts of overlapping things (asserts and replays are checks, not actions). The checks line is now the only count; the action line says how many actions were driven and lists them.
