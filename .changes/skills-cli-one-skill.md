### Fixed

- **Skill — `npx skills add reticlehq/reticle --skill reticle` installed the wrong files.** On macOS and Windows it copied the whole `docs/` directory (about 11 MB) as the skill. On Linux it copied the Claude Code plugin, whose text said that the plugin had registered the MCP server. The command now installs one file, `skills/reticle/SKILL.md`. The skill file, the docs copy, the plugin copy and `install-and-verify` now have the same text, written from the root `SKILL.md`. The Claude Code plugin moved to `plugins/reticle/`; `/plugin install reticle@reticlehq` does not change.
