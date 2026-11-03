### Fixed

- **`@reticlehq/engine` — a GET that listed old failed records gave a false `no`.** `partial-failure-in-ok-response` read every item array in a 2xx body as the items of a batch. A GET of a job list that held old, failed jobs was then reported as "2 of 3 items FAILED", and an assert whose predicate held answered `no`. The rule now counts items only for a write, or for a call whose method was not recorded. A GET whose own body says the read failed is still reported. Known limit: a batch whose per-item results are read back only by polling a GET is no longer reported from that GET.
