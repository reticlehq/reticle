### Fixed

- The no-session scan now also probes `PORT=` from the project's `.env` files and, on Linux and macOS, the ports that processes inside the project listen on. An app whose port no `dev` script names is no longer reported as not running. When the scan still finds nothing, the answer lists what it checked and names `reticle_lease`. (#1543)
