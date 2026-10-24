### Fixed

- **`@reticlehq/core` — the coverage prompt from `init` and `doctor` ended with a command that refused its own argument.** It said `reticle verify <url> --expect "<one journey you changed>"`, but `--expect` takes a JSON predicate and refuses prose. The prompt now says `npx @reticlehq/server verify <url> --expect '<JSON predicate for the end state of one journey you changed>'`.
