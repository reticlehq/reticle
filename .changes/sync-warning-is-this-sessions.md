### Fixed

- **`@reticlehq/server` — every result warned about another session's unsent flow.** "Runs are not reaching the platform (… flow drive-runs-that-failed-overview …)" was appended to the results of an agent session that had written no such flow. A sync problem is now said to the agent session whose own runs or flows it holds back; a refused key, which holds back everything, is still said to all.
