### Fixed

- **`@reticlehq/server` — `reticle compare` no longer reports a correct build as different when a step fails only once.** Before, if a step failed once on the candidate, compare counted it as a step the candidate could not do. This happened with a select whose options load after another select, on a loaded machine. Compare now tries that run once more, from a fresh page. A step that fails on both tries still counts as a difference. A step that fails once and then passes is never hidden: it is listed in `intermittent` in the JSON and in the text output, whatever the verdict.
