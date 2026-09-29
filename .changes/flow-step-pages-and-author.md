### Added

- **`@reticlehq/server` + `@reticlehq/core`: saved steps record their pages, and flows record who made them.** Each step carries `page` (where it ran) and `endPage` (where it led). Flows carry `author: { agent, person }`, from the MCP client and the account `reticle login` signed in (the login now remembers its email), and declare `requires`/`ensures` from their start and end pages. Replay treats a required start page as met by navigating there.
