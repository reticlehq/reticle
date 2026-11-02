### Fixed

- The no-session scan now also probes `PORT=` from the project's `.env` files. An app whose port is set only there is no longer reported as not running. When the scan still finds nothing, the answer lists what it checked and names `reticle_lease`. (#1543)
