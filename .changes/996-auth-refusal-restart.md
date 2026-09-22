### Fixed

- **`@reticlehq/server` — a refused dial told the page to reload, which serves the same pairing token.** The close reason said to reload the page to pick up the current token. Vite inlines that token when the dev server starts and keeps it in the prebundled module, so a reload fetches the same file and the refusal never clears. The recorded reason is now the one sent on the socket, and the remedy is to restart the dev server. See [#996](https://github.com/reticlehq/reticle/issues/996).
