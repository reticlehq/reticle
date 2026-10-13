### Changed

- **Agents write the text Reticle keeps in Simplified Technical English.** The MCP briefing, the Harness prompt and `SKILL.md` now tell an agent to write flow names, notes, feedback, summaries and plans in ASD-STE100 style: short sentences, active voice, one meaning for each word, no idioms. Other agents and people read this text later, and a literal sentence keeps one meaning for all of them. `@reticlehq/core` exports the rule as `WRITING_RULE` and `WRITING_RULE_SHORT`, so every prompt reads the same words.
