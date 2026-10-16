### Fixed

- **`@reticlehq/server` � `reticle kill` could fail to identify a daemon holding a port on Windows.** Port detection now handles IPv4 and IPv6 listener output from `netstat`, helping Reticle identify the process to terminate.
