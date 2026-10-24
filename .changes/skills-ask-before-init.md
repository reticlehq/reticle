### Fixed

- **Skills — the task skills no longer tell an agent to run `init` without asking.** Fifteen skills said "Not installed?" and gave the `init` command, so an agent changed the app's files without the user's agreement. 3.8.0 runs `init` only when the user agrees. These skills now send the agent to the `reticle` skill, which installs Reticle, asks the user before `init` changes the app's files, and proves one flow. The `fix-what-i-pointed-at` skill named a **Flag a bug** control that the HUD does not have. It now names the **Notes** panel and its **Add notes** button.
