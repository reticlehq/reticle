### Fixed

- **A Harness answer counts its checks the way the platform counts the run's.** The answer counted one check per control at its worst outcome, the platform distinct (kind, claim, outcome) of the run's checks, so "2 of 2 held" sat beside a run the dashboard counted differently. The answer now counts the same set; a claim that held once and failed once is one held and one failed in both places.
