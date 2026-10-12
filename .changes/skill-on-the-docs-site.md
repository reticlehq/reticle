### Changed

- **The skill file lives on the docs site.** `https://docs.reticle.sh/skill.md` serves the canonical `SKILL.md` with Agent Skill frontmatter, instead of a skill the docs host generated from the pages. It is the URL to hand an agent. The repository copy keeps the same body, and a test fails if the two differ.
- **`SKILL.md` rewritten as the one file an agent needs.** What Reticle is and how it fits together, the first move, the rules, every advertised tool and action, the full predicate grammar, the Harness, instrumentation, the CLI, what to do when a call fails, and a map of every docs page. It stays inside its size budget.
- **Install docs start with the installer.** README, the docs home and the agentic-install page lead with the one-line installer and then the steps it prints, instead of a prompt to paste first: an agent loads MCP tools only when it starts, so the first step has to be a command.
