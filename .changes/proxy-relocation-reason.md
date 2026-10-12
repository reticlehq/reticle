### Fixed

- **`@reticlehq/server` — a proxy that moved off the requested port always said "the requested port serves a different project".** The commonest move is to this project's own daemon, already running elsewhere (for example on the default port). `reticle_mcp_port_relocated` now says which of the cases happened and how to get the requested port: stop the project's other daemon, or give this project its own port when another project holds it.
