### Fixed

- **The Harness's two-way comparison no longer reads the agent's "not shown" check as "shown".** An agent's pre-check that some words were absent, proved `yes`, was compared as the agent proving those words were on the page, and produced a "hard to find" finding from a check that said the opposite. An absence in the agent's claim is now left out of the comparison; the positive part of a mixed claim still counts.
