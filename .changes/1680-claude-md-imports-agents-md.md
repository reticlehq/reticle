### Fixed

- **`@reticlehq/init` — `reticle init` wrote its rule into a `CLAUDE.md` that only imports `AGENTS.md`, so Claude Code loaded the rule twice.** Many repositories keep one rule file for every agent and make `CLAUDE.md` a single `@AGENTS.md` import. init now leaves such a `CLAUDE.md` as it is and says the rule reaches Claude Code through the import; `AGENTS.md` still gets the rule. Closes [#1680](https://github.com/reticlehq/reticle/issues/1680).
