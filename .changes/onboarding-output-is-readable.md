### Changed

- **`reticle init` prints a report you can read, not one you skim past.** A measured first run on a pristine Vite + React app printed forty-six lines, and twelve of them were Reticle saying it had done nothing: six `[·] MCP server (<client>)` rows, each followed by an indented line repeating the title back to you. A first-time reader met six tool names they may not use before reaching anything about their own app. Every step still gets its row, because that is what tells you which of your files changed. What is gone is the second line on every step that asks nothing of you; the detail stays in full on the steps that do.

- **The last line of onboarding is three short sentences instead of one paragraph.** It was a single eighty-three-word block addressed to an agent, printed to whoever had just typed `reticle init` in a terminal and has no `reticle_*` tools to call. Same facts, split, and each line now says who it is for.

### Fixed

- **"Add the reticle entry by hand" is said once, not on every run forever.** Two commands register MCP clients on purpose, so a `curl … | sh` followed by `reticle init` printed the same two paragraphs about your Zed or Continue config twice in one sitting, and again on every re-run after that. The registration is unchanged; the sentence is now remembered per machine, keyed on its own text, so a config you edit is reported again and one you leave alone is not.
