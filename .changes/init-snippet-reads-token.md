### Fixed

- **`@reticlehq/init` — `reticle init` no longer prints the pairing token.** For a project with no `package.json` (Django, Streamlit, a page not at the root) and for the hand-wired recipe, the printed connect snippet held this machine's pairing token as a literal. It then stayed in terminal history, in agent transcripts and in every file the snippet went into. The page snippets now import the token from `reticle.local.js`, which init writes and adds to `.gitignore`. The Django and Streamlit snippets read the token file when the page is served.
