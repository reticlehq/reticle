### Fixed

- **A folder re-linked to another workspace no longer sends the previous workspace's flows.** The runs made under the old link stayed on the machine, but its flows went to the new workspace, carrying the steps (and the email addresses) of the people who drove them. Flows now follow the same rule as runs: those made before the re-link stay until `reticle sync --move-history` sends them, and the sync says how many it kept back.
