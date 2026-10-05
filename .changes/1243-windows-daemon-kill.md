### Fixed

- @reticlehq/server: reticle kill --force could report success on Windows while a daemon was still running because lsof was unavailable. The CLI now falls back to Windows netstat to identify the process listening on the port and verifies that the port is actually free before reporting success. Closes #1243.
